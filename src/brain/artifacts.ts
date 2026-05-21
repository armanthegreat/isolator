import { FileSystem } from "@effect/platform";
import { Effect, Schema } from "effect";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { VaultReadError, VaultWriteError } from "./errors.ts";
import {
  ArtifactFrontmatter,
  type ArtifactStatus,
  type ContextManifest,
  type StepOutput,
} from "./schemas.ts";

/**
 * Artifact write-back.
 *
 * Every artifact a step produces is written into the vault with a §11
 * frontmatter block on top. The frontmatter carries lineage (who produced
 * this version, in which run), a monotonic version counter, and a lifecycle
 * status — so downstream steps and the operator can tell whether an artifact
 * is draft, approved, or stale.
 *
 * This module also owns committing the run's `context-manifest.yml` into
 * `projects/<slug>/runs/<run-id>/`, since both the artifact and the manifest
 * share the same vault-relative addressing.
 */

/** Frontmatter delimiter — kept fixed (no `+++` TOML, no excerpt support). */
const FENCE = "---";

/** A re-used header line for the `---` block. */
const FENCE_LINE = `${FENCE}\n`;

/** Inputs for {@link writeArtifact}. */
export interface WriteArtifactOptions {
  /** Absolute vault path. */
  readonly vaultPath: string;
  /** Project slug — the artifact lands under `projects/<slug>/`. */
  readonly project: string;
  /** Step id producing the artifact (recorded in frontmatter). */
  readonly stepId: string;
  /** Run id producing this version (recorded in frontmatter). */
  readonly runId: string;
  /** Output descriptor — drives the destination path + type label. */
  readonly output: StepOutput;
  /** Artifact body (no frontmatter — this module injects/repairs it). */
  readonly body: string;
  /** Lifecycle status to record; defaults to `"draft"`. */
  readonly status?: ArtifactStatus;
  /** Whether the artifact needs an approval gate. */
  readonly approvalRequired?: boolean;
}

/** Outcome of a successful artifact write. */
export interface WrittenArtifact {
  /** Vault-relative path of the artifact (e.g. `"projects/demo/prd/PRD.md"`). */
  readonly relPath: string;
  /** Absolute path of the artifact on disk. */
  readonly absPath: string;
  /** Final frontmatter as written. */
  readonly frontmatter: ArtifactFrontmatter;
}

/**
 * Best-effort frontmatter parse. Returns `undefined` when the file has no
 * fence; surfaces malformed YAML as `undefined` rather than throwing, since
 * the caller's job is to *repair* frontmatter, not to fail on it.
 *
 * Exported so other vault-document modules (e.g. `projects.ts`, which reads
 * `overview.md`) can share one frontmatter splitter.
 */
export const parseFrontmatter = (
  text: string,
):
  | { readonly frontmatter: Record<string, unknown>; readonly body: string }
  | undefined => {
  if (!text.startsWith(`${FENCE}\n`) && !text.startsWith(`${FENCE}\r\n`)) {
    return undefined;
  }
  const after = text.slice(text.indexOf("\n") + 1);
  const closeIdx = after.indexOf(`\n${FENCE}`);
  if (closeIdx === -1) return undefined;
  const yamlBlock = after.slice(0, closeIdx);
  const rest = after.slice(closeIdx + 1 + FENCE.length);
  const body = rest.startsWith("\n") ? rest.slice(1) : rest;
  try {
    const parsed = parseYaml(yamlBlock) as Record<string, unknown> | null;
    return { frontmatter: parsed ?? {}, body };
  } catch {
    return undefined;
  }
};

/** Read the existing version number, defaulting to 0 if absent or unparseable. */
const existingVersion = (text: string | undefined): number => {
  if (text === undefined) return 0;
  const parsed = parseFrontmatter(text);
  if (parsed === undefined) return 0;
  const raw = parsed.frontmatter["version"];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
};

/** Compose `<artifact_id>` from project, type, and the step's `path`. */
const composeArtifactId = (project: string, output: StepOutput): string => {
  const slug = output.path
    .replace(/\.[^/.]+$/, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `${project}/${output.type}/${slug}`;
};

const encodeFrontmatter = Schema.encodeUnknownSync(ArtifactFrontmatter);

const serialize = (frontmatter: ArtifactFrontmatter, body: string): string => {
  const yaml = stringifyYaml(encodeFrontmatter(frontmatter)).trimEnd();
  const tail = body.endsWith("\n") ? body : `${body}\n`;
  return `${FENCE_LINE}${yaml}\n${FENCE_LINE}${tail}`;
};

const readFileIfPresent = (
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<string | undefined, never> =>
  fs
    .readFileString(path)
    .pipe(Effect.catchAll(() => Effect.succeed(undefined)));

/**
 * Write a single artifact into the vault, injecting/repairing §11
 * frontmatter and bumping the version when a prior copy exists.
 */
export const writeArtifact = (
  options: WriteArtifactOptions,
): Effect.Effect<
  WrittenArtifact,
  VaultReadError | VaultWriteError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const relPath = join("projects", options.project, options.output.path);
    const absPath = join(options.vaultPath, relPath);

    const existing = yield* readFileIfPresent(fs, absPath);
    const nextVersion = existingVersion(existing) + 1;

    const frontmatter: ArtifactFrontmatter = {
      artifact_id: composeArtifactId(options.project, options.output),
      artifact_type: options.output.type,
      project: options.project,
      produced_by: options.stepId,
      produced_in_run: options.runId,
      version: nextVersion,
      status: options.status ?? "draft",
      approval_required: options.approvalRequired ?? false,
      consumers: [],
    };

    yield* fs.makeDirectory(dirname(absPath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new VaultWriteError({
            path: absPath,
            message: `Could not create artifact directory: ${cause}`,
          }),
      ),
    );

    yield* fs
      .writeFileString(absPath, serialize(frontmatter, options.body))
      .pipe(
        Effect.mapError(
          (cause) =>
            new VaultWriteError({
              path: absPath,
              message: `Could not write artifact: ${cause}`,
            }),
        ),
      );

    return { relPath, absPath, frontmatter } satisfies WrittenArtifact;
  });

/**
 * Write the run's `context-manifest.yml` into the vault under
 * `projects/<slug>/runs/<run-id>/`. Returns its vault-relative path so the
 * caller can record it in the run's `RunRecord`.
 */
export const writeContextManifest = (
  vaultPath: string,
  manifest: ContextManifest,
): Effect.Effect<string, VaultWriteError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const relPath = join(
      "projects",
      manifest.project,
      "runs",
      manifest.run_id,
      "context-manifest.yml",
    );
    const absPath = join(vaultPath, relPath);

    yield* fs.makeDirectory(dirname(absPath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new VaultWriteError({
            path: absPath,
            message: `Could not create manifest directory: ${cause}`,
          }),
      ),
    );

    yield* fs.writeFileString(absPath, stringifyYaml(manifest)).pipe(
      Effect.mapError(
        (cause) =>
          new VaultWriteError({
            path: absPath,
            message: `Could not write context manifest: ${cause}`,
          }),
      ),
    );

    return relPath;
  });

/**
 * Read an artifact's frontmatter back from the vault. Returns `undefined`
 * when the file is missing or has no frontmatter; surfaces only IO failures.
 *
 * Useful for the `artifact_frontmatter_valid` validator and for gates that
 * flip an artifact's `status` to `approved`.
 */
export const readArtifactFrontmatter = (
  absPath: string,
): Effect.Effect<
  ArtifactFrontmatter | undefined,
  VaultReadError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs
      .exists(absPath)
      .pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (!exists) return undefined;
    const text = yield* fs.readFileString(absPath).pipe(
      Effect.mapError(
        (cause) =>
          new VaultReadError({
            path: absPath,
            message: `Could not read artifact: ${cause}`,
          }),
      ),
    );
    const parsed = parseFrontmatter(text);
    if (parsed === undefined) return undefined;
    try {
      return Schema.decodeUnknownSync(ArtifactFrontmatter)(parsed.frontmatter);
    } catch {
      return undefined;
    }
  });

/**
 * Mark an artifact `status: approved` in place, recording when and by whom.
 *
 * This is the write half of an approval gate: `gate()` throws while an
 * artifact is `draft`; `isolator continue` calls this to clear the gate, then
 * re-runs the pipeline so the now-approved gate passes. A no-op-safe repeat
 * call simply rewrites the same `approved` status with a fresh timestamp.
 *
 * Fails with `VaultReadError` when the file is missing and `VaultWriteError`
 * when it has no parseable §11 frontmatter (an artifact that was never written
 * by {@link writeArtifact} cannot be approved). Returns the updated frontmatter.
 */
export const approveArtifact = (
  absPath: string,
  approvedBy = "isolator continue",
): Effect.Effect<
  ArtifactFrontmatter,
  VaultReadError | VaultWriteError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(absPath).pipe(
      Effect.mapError(
        (cause) =>
          new VaultReadError({
            path: absPath,
            message: `Could not read artifact: ${cause}`,
          }),
      ),
    );
    const parsed = parseFrontmatter(text);
    if (parsed === undefined) {
      return yield* new VaultWriteError({
        path: absPath,
        message: "Artifact has no frontmatter — cannot approve it.",
      });
    }
    const current = yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(ArtifactFrontmatter)(parsed.frontmatter),
      catch: (cause) =>
        new VaultWriteError({
          path: absPath,
          message: `Artifact frontmatter is invalid — cannot approve it: ${cause}`,
        }),
    });
    const approved: ArtifactFrontmatter = {
      ...current,
      status: "approved",
      approved_at: new Date().toISOString(),
      approved_by: approvedBy,
    };
    yield* fs.writeFileString(absPath, serialize(approved, parsed.body)).pipe(
      Effect.mapError(
        (cause) =>
          new VaultWriteError({
            path: absPath,
            message: `Could not write approved artifact: ${cause}`,
          }),
      ),
    );
    return approved;
  });

/** Exported for testing only — direct access to the frontmatter parser. */
export const __testing__ = { parseFrontmatter };
