import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { join } from "node:path";
import { readArtifactFrontmatter } from "./artifacts.ts";
import type { StepOutput } from "./schemas.ts";

/**
 * Output contracts — the named predicates a step's `validate` array refers
 * to. Each validator inspects the vault after a run and returns a typed
 * `ValidationResult`; failures are surfaced in the `RunRecord` but never
 * thrown (the orchestrator decides what to do with a failed step).
 *
 * The set is deliberately small and stable. Adding a new predicate means
 * adding an entry to the {@link validators} registry; pipelines reference
 * them by name only, so the wire format stays JSON-friendly.
 */

/** A single validator's verdict. */
export interface ValidationResult {
  /** Predicate name as referenced in `StepConfig.validate`. */
  readonly name: string;
  /** Whether the predicate passed. */
  readonly passed: boolean;
  /** Free-form explanation when `passed` is false. */
  readonly message?: string;
}

/** Inputs every validator receives. */
export interface ValidationContext {
  /** Absolute vault path. */
  readonly vaultPath: string;
  /** Project slug. */
  readonly project: string;
  /** Run id whose context manifest we expect under `runs/<run-id>/`. */
  readonly runId: string;
  /** The step's declared outputs — used by file-existence + frontmatter checks. */
  readonly outputs: readonly StepOutput[];
}

/** A validator is an Effect requiring the FileSystem; failures are typed as `never`. */
export type Validator = (
  ctx: ValidationContext,
) => Effect.Effect<ValidationResult, never, FileSystem.FileSystem>;

/** Sections every PRD artifact must contain. */
const PRD_REQUIRED_SECTIONS = [
  "Problem",
  "Users",
  "Goals",
  "Non-goals",
  "Success criteria",
  "Open questions",
] as const;

const pass = (name: string): ValidationResult => ({ name, passed: true });

const fail = (name: string, message: string): ValidationResult => ({
  name,
  passed: false,
  message,
});

const fileExists = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs
      .exists(path)
      .pipe(Effect.catchAll(() => Effect.succeed(false)));
  });

const allRequiredOutputsExist: Validator = (ctx) =>
  Effect.gen(function* () {
    const missing: string[] = [];
    for (const output of ctx.outputs) {
      const relPath = join("projects", ctx.project, output.path);
      const absPath = join(ctx.vaultPath, relPath);
      const ok = yield* fileExists(absPath);
      if (!ok) missing.push(relPath);
    }
    return missing.length === 0
      ? pass("all_required_outputs_exist")
      : fail(
          "all_required_outputs_exist",
          `Missing artifacts: ${missing.join(", ")}`,
        );
  });

const prdOutputs = (outputs: readonly StepOutput[]) =>
  outputs.filter((output) => output.type === "prd");

const prdHasRequiredSections: Validator = (ctx) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const prds = prdOutputs(ctx.outputs);
    if (prds.length === 0) {
      return fail(
        "prd_has_required_sections",
        'Step has no output of type "prd".',
      );
    }
    const problems: string[] = [];
    for (const output of prds) {
      const absPath = join(ctx.vaultPath, "projects", ctx.project, output.path);
      const present = yield* fs
        .exists(absPath)
        .pipe(Effect.catchAll(() => Effect.succeed(false)));
      if (!present) {
        problems.push(`${output.path}: file missing`);
        continue;
      }
      const text = yield* fs
        .readFileString(absPath)
        .pipe(Effect.catchAll(() => Effect.succeed("")));
      const headings = new Set(
        text
          .split("\n")
          .filter((line) => line.startsWith("## "))
          .map((line) => line.slice(3).trim().toLowerCase()),
      );
      const missing = PRD_REQUIRED_SECTIONS.filter(
        (section) => !headings.has(section.toLowerCase()),
      );
      if (missing.length > 0) {
        problems.push(
          `${output.path}: missing sections [${missing.join(", ")}]`,
        );
      }
    }
    return problems.length === 0
      ? pass("prd_has_required_sections")
      : fail("prd_has_required_sections", problems.join("; "));
  });

const openQuestionsResolved: Validator = (ctx) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const oqs = ctx.outputs.filter(
      (output) => output.type === "open_questions",
    );
    if (oqs.length === 0) return pass("open_questions_resolved");
    const unanswered: string[] = [];
    for (const output of oqs) {
      const absPath = join(ctx.vaultPath, "projects", ctx.project, output.path);
      const present = yield* fs
        .exists(absPath)
        .pipe(Effect.catchAll(() => Effect.succeed(false)));
      if (!present) continue;
      const text = yield* fs
        .readFileString(absPath)
        .pipe(Effect.catchAll(() => Effect.succeed("")));
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!.trim();
        const question = /^-\s*Q:\s*(.+?)\s*$/.exec(line);
        if (!question) continue;
        const next = (lines[i + 1] ?? "").trim();
        const answer = /^-\s*A:\s*(.*)$/.exec(next);
        if (answer === null || (answer[1] ?? "").trim() === "") {
          unanswered.push(question[1]!);
        }
      }
    }
    return unanswered.length === 0
      ? pass("open_questions_resolved")
      : fail("open_questions_resolved", `Unanswered: ${unanswered.join("; ")}`);
  });

const artifactFrontmatterValid: Validator = (ctx) =>
  Effect.gen(function* () {
    const problems: string[] = [];
    for (const output of ctx.outputs) {
      const absPath = join(ctx.vaultPath, "projects", ctx.project, output.path);
      const fm = yield* readArtifactFrontmatter(absPath).pipe(
        Effect.catchAll(() => Effect.succeed(undefined)),
      );
      if (fm === undefined) {
        problems.push(`${output.path}: missing or invalid frontmatter`);
        continue;
      }
      if (fm.artifact_type !== output.type) {
        problems.push(
          `${output.path}: frontmatter type "${fm.artifact_type}" ≠ contract "${output.type}"`,
        );
      }
      if (fm.project !== ctx.project) {
        problems.push(
          `${output.path}: frontmatter project "${fm.project}" ≠ run project "${ctx.project}"`,
        );
      }
    }
    return problems.length === 0
      ? pass("artifact_frontmatter_valid")
      : fail("artifact_frontmatter_valid", problems.join("; "));
  });

const runManifestCommitted: Validator = (ctx) =>
  Effect.gen(function* () {
    const absPath = join(
      ctx.vaultPath,
      "projects",
      ctx.project,
      "runs",
      ctx.runId,
      "context-manifest.yml",
    );
    const ok = yield* fileExists(absPath);
    return ok
      ? pass("run_manifest_committed")
      : fail(
          "run_manifest_committed",
          `No context-manifest.yml under runs/${ctx.runId}/`,
        );
  });

/** Registry of all named validators. */
export const validators: Readonly<Record<string, Validator>> = {
  all_required_outputs_exist: allRequiredOutputsExist,
  prd_has_required_sections: prdHasRequiredSections,
  open_questions_resolved: openQuestionsResolved,
  artifact_frontmatter_valid: artifactFrontmatterValid,
  run_manifest_committed: runManifestCommitted,
};

/**
 * Run a list of validators by name. Unknown names produce a failed result
 * instead of throwing, so a typo in `StepConfig.validate` surfaces in the
 * run record rather than crashing the run.
 */
export const runValidators = (
  names: readonly string[],
  ctx: ValidationContext,
): Effect.Effect<ValidationResult[], never, FileSystem.FileSystem> =>
  Effect.all(
    names.map((name) => {
      const validator = validators[name];
      if (validator === undefined) {
        return Effect.succeed(fail(name, "Unknown validator."));
      }
      return validator(ctx);
    }),
  );
