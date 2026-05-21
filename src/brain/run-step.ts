import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeCode } from "../AgentProvider.ts";
import { Output, type OutputStringDefinition } from "../Output.ts";
import {
  type IterationResult,
  run,
  type RunOptions,
  type RunResult,
} from "../run.ts";
import { docker } from "../sandboxes/docker.ts";
import {
  readArtifactFrontmatter,
  writeArtifact,
  type WrittenArtifact,
  writeContextManifest,
} from "./artifacts.ts";
import {
  defaultIsolatorHomeLayer,
  isolatorHomeLayer,
  loadConfig,
} from "./config.ts";
import { compileContext, type CompiledContext } from "./context-compiler.ts";
import { runValidators, type ValidationResult } from "./contracts.ts";
import { toProjectSlug } from "./projects.ts";
import { composePrompt, OUTPUT_TAG } from "./prompt-stack.ts";
import type { ContextPolicy, RunRecord, StepOutput } from "./schemas.ts";
import { loadSkills, type Skill } from "./skills.ts";
import { appendRunRecord } from "./telemetry.ts";
import { BASE_PROMPT_PATH, readNote } from "./vault.ts";

/**
 * `runStep()` — the core brain primitive.
 *
 * isolator's unit is a raw `run()`; the brain's unit is a *brain-backed step*.
 * `runStep` resolves the project from `~/.isolator/config.yml`, compiles the
 * step's scoped context, composes a prompt (base + role + skills + staged
 * context + objective + output contract + verification + failure policy),
 * runs the agent in a sandbox via isolator's `run()`, writes the produced
 * artifact back into the vault with §11 frontmatter, runs the named
 * validators, and appends a telemetry line to `system/runs.jsonl`.
 *
 * The full pipeline is *all-optional past Phase 1*: `context`, `skill(s)`,
 * `role`, `validate`, `gate` are all opt-in. A minimal call still works —
 * objective + single output — preserving the Phase 1 echo pipeline.
 */

/** Default model when neither the step nor the config specifies one. */
const DEFAULT_MODEL = "claude-opus-4-7";

/** Env var the `claude` CLI reads for Pro/Max subscription auth. */
const OAUTH_TOKEN_KEY = "CLAUDE_CODE_OAUTH_TOKEN";

/**
 * The slice of isolator's `run()` that `runStep` depends on — the
 * string-output overload. Exposed so tests can inject a fake runner.
 */
export type StepRunner = (
  options: RunOptions & { output: OutputStringDefinition },
) => Promise<RunResult & { output: string }>;

/** A single artifact a step produces, written back into the vault. */
export interface StepArtifact {
  /** Artifact type label (e.g. `"echo"`, `"prd"`). */
  readonly type: string;
  /** Path within `projects/<slug>/`, e.g. `"echo.md"`. */
  readonly path: string;
}

/** Inputs to {@link runStep}. */
export interface RunStepOptions {
  /** Project name or slug; normalized via {@link toProjectSlug}. */
  readonly project: string;
  /** Step id, e.g. `"echo"`. */
  readonly id: string;
  /** The step objective handed to the agent. */
  readonly prompt: string;
  /** The primary artifact — emitted via `<step_output>` and written to the vault. */
  readonly output: StepArtifact;
  /** Additional artifacts the step contracts to produce; used by validators. */
  readonly outputs?: readonly StepOutput[];
  /** Single skill bundle to load. */
  readonly skill?: string;
  /** Multiple skill bundles to load (in addition to `skill`). */
  readonly skills?: readonly string[];
  /** Role file (without `.md`) loaded from `<vault>/roles/`. */
  readonly role?: string;
  /** Vault globs declaring the step's input context. */
  readonly context?: readonly string[];
  /** Budget caps for the context compiler. */
  readonly contextPolicy?: ContextPolicy;
  /** Names of validators that must run after the step. */
  readonly validate?: readonly string[];
  /** Approval gate to pause on; consumed by the pipeline via {@link gate}. */
  readonly gate?: string;
  /** Model override; defaults to config `defaults.model`, then `claude-opus-4-7`. */
  readonly model?: string;
  /** Docker image override; defaults to config `defaults.image`. */
  readonly image?: string;
  /** Override the `~/.isolator` home directory — test seam. */
  readonly home?: string;
  /** Override isolator's `run()` — test seam. */
  readonly runner?: StepRunner;
}

/** Outcome of a successful {@link runStep}. */
export interface StepResult {
  /** Unique id of the run. */
  readonly runId: string;
  /** Id of the step that ran. */
  readonly stepId: string;
  /** Project slug. */
  readonly project: string;
  /** Absolute path of the primary artifact written into the vault. */
  readonly artifactPath: string;
  /** Frontmatter records of every artifact this step wrote into the vault. */
  readonly artifacts: readonly WrittenArtifact[];
  /** Vault-relative path of the context manifest, when one was written. */
  readonly contextManifestPath?: string;
  /** Combined agent stdout. */
  readonly stdout: string;
  /** Whether the run succeeded. */
  readonly success: boolean;
  /** Verdicts from the validators that ran; empty when none were configured. */
  readonly validation: readonly ValidationResult[];
  /** Name of the gate the step is pausing on, if any. */
  readonly pendingGate?: string;
}

/** Generate a sortable, unique run id. */
const makeRunId = (): string =>
  `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;

/** Read the subscription OAuth token from the environment or `~/.isolator/.env`. */
const readOAuthToken = async (homeDir: string): Promise<string | undefined> => {
  const fromProcess = process.env[OAUTH_TOKEN_KEY]?.trim();
  if (fromProcess) return fromProcess;
  try {
    const content = await readFile(join(homeDir, ".env"), "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq !== -1 && trimmed.slice(0, eq).trim() === OAUTH_TOKEN_KEY) {
        return trimmed.slice(eq + 1).trim() || undefined;
      }
    }
  } catch {
    // No ~/.isolator/.env — fall through to undefined.
  }
  return undefined;
};

/** Sum input/output token usage across a run's iterations. */
const sumTokens = (
  iterations: readonly IterationResult[],
): { readonly in: number; readonly out: number } => {
  let tokensIn = 0;
  let tokensOut = 0;
  for (const { usage } of iterations) {
    if (usage === undefined) continue;
    tokensIn +=
      usage.inputTokens +
      usage.cacheCreationInputTokens +
      usage.cacheReadInputTokens;
    tokensOut += usage.outputTokens;
  }
  return { in: tokensIn, out: tokensOut };
};

/** Resolve the merged list of skill ids from `skill` and `skills`. */
const resolveSkillIds = (options: RunStepOptions): readonly string[] => {
  const set = new Set<string>();
  if (options.skill) set.add(options.skill);
  for (const id of options.skills ?? []) set.add(id);
  return [...set];
};

/** Resolve the full output contract — primary first, then any extras. */
const resolveOutputs = (options: RunStepOptions): readonly StepOutput[] => {
  const primary: StepOutput = options.output;
  const extras = (options.outputs ?? []).filter(
    (entry) => entry.path !== primary.path,
  );
  return [primary, ...extras];
};

/**
 * Run a single brain-backed step end to end.
 */
export const runStep = async (options: RunStepOptions): Promise<StepResult> => {
  const slug = toProjectSlug(options.project);
  if (slug === "") {
    throw new Error(`Invalid project name "${options.project}".`);
  }

  const homeDir = options.home ?? join(homedir(), ".isolator");
  const homeLayer = options.home
    ? isolatorHomeLayer(options.home)
    : defaultIsolatorHomeLayer;
  const baseLayer = Layer.merge(homeLayer, NodeContext.layer);
  const fsLayer = NodeContext.layer;

  const config = await Effect.runPromise(
    loadConfig.pipe(Effect.provide(baseLayer)),
  ).catch((cause: unknown) => {
    throw new Error(
      `Could not load the isolator config: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  });

  const projectEntry = config.projects[slug];
  if (projectEntry === undefined) {
    throw new Error(
      `Project "${slug}" is not connected. Run \`isolator connect ${slug}\` first.`,
    );
  }

  const vaultPath = config.vault_path;
  const model =
    options.model ??
    projectEntry.model ??
    config.defaults.model ??
    DEFAULT_MODEL;
  // Image-by-convention: `isolator:<slug>`, built from the project's
  // `.isolator/Dockerfile`. Overridable per call (`options.image`) or per
  // tenant (`config.defaults.image`) when a project needs a different image.
  const image = options.image ?? config.defaults.image ?? `isolator:${slug}`;
  const token = await readOAuthToken(homeDir);
  const runner = options.runner ?? run;

  const runId = makeRunId();
  const startedAt = new Date().toISOString();
  const outputs = resolveOutputs(options);

  // 1. Compile context (if any patterns declared) and write its manifest.
  let compiledContext: CompiledContext | undefined;
  let contextManifestPath: string | undefined;
  if (options.context && options.context.length > 0) {
    compiledContext = await Effect.runPromise(
      compileContext({
        vaultPath,
        project: slug,
        stepId: options.id,
        runId,
        patterns: options.context,
        policy: options.contextPolicy,
      }).pipe(Effect.provide(fsLayer)),
    );
    contextManifestPath = await Effect.runPromise(
      writeContextManifest(vaultPath, compiledContext.manifest).pipe(
        Effect.provide(fsLayer),
      ),
    );
  }

  // 2. Load skills + role + base prompt.
  const skillIds = resolveSkillIds(options);
  const skills: readonly Skill[] =
    skillIds.length === 0
      ? []
      : await Effect.runPromise(
          loadSkills(vaultPath, skillIds).pipe(Effect.provide(fsLayer)),
        );
  const role = options.role
    ? {
        id: options.role,
        markdown: await Effect.runPromise(
          readNote(vaultPath, join("roles", `${options.role}.md`)).pipe(
            Effect.provide(fsLayer),
          ),
        ),
      }
    : undefined;
  const base = await Effect.runPromise(
    readNote(vaultPath, BASE_PROMPT_PATH).pipe(Effect.provide(fsLayer)),
  ).catch(() => "");

  // 3. Compose the prompt.
  const prompt = composePrompt({
    base,
    role,
    skills,
    context: compiledContext?.files,
    objective: options.prompt,
    output: outputs,
    validate: options.validate,
  });

  // 4. Run the agent.
  const runDir = join(vaultPath, "projects", slug, "runs", runId);
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(runDir, { recursive: true });
    }).pipe(Effect.provide(fsLayer)),
  ).catch(() => undefined);

  let runResult: RunResult & { output: string };
  try {
    runResult = await runner({
      name: `brain:${slug}:${options.id}`,
      agent: claudeCode(
        model,
        token ? { env: { [OAUTH_TOKEN_KEY]: token } } : undefined,
      ),
      sandbox: docker({ imageName: image }),
      cwd: projectEntry.repo_path,
      prompt,
      maxIterations: 1,
      logging: { type: "file", path: join(runDir, "agent.log") },
      output: Output.string({ tag: OUTPUT_TAG }),
    });
  } catch (cause) {
    await Effect.runPromise(
      appendRunRecord(vaultPath, {
        run_id: runId,
        project: slug,
        step_id: options.id,
        agent: "claude-code",
        model,
        tokens_in: 0,
        tokens_out: 0,
        duration_ms: Date.now() - Date.parse(startedAt),
        success: false,
        validation_results: [],
        artifact_paths: [],
        context_manifest_path: contextManifestPath,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
      }).pipe(Effect.provide(fsLayer)),
    ).catch(() => undefined);
    throw cause;
  }

  // 5. Write the primary artifact (with §11 frontmatter).
  const primary = await Effect.runPromise(
    writeArtifact({
      vaultPath,
      project: slug,
      stepId: options.id,
      runId,
      output: options.output,
      body: runResult.output,
      approvalRequired: options.gate !== undefined,
    }).pipe(Effect.provide(fsLayer)),
  );
  const artifacts: WrittenArtifact[] = [primary];

  // 6. Run validators.
  const validation =
    options.validate && options.validate.length > 0
      ? await Effect.runPromise(
          runValidators(options.validate, {
            vaultPath,
            project: slug,
            runId,
            outputs,
          }).pipe(Effect.provide(fsLayer)),
        )
      : [];
  const allPassed = validation.every((v) => v.passed);

  // 7. Append the telemetry record.
  const tokens = sumTokens(runResult.iterations);
  const record: RunRecord = {
    run_id: runId,
    project: slug,
    step_id: options.id,
    agent: "claude-code",
    model,
    tokens_in: tokens.in,
    tokens_out: tokens.out,
    duration_ms: Date.now() - Date.parse(startedAt),
    success: allPassed,
    validation_results: validation.filter((v) => v.passed).map((v) => v.name),
    artifact_paths: artifacts.map((a) => a.relPath),
    context_manifest_path: contextManifestPath,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };
  await Effect.runPromise(
    appendRunRecord(vaultPath, record).pipe(Effect.provide(fsLayer)),
  );

  return {
    runId,
    stepId: options.id,
    project: slug,
    artifactPath: primary.absPath,
    artifacts,
    contextManifestPath,
    stdout: runResult.stdout,
    success: allPassed,
    validation,
    pendingGate: options.gate,
  };
};

/**
 * Approval gate. Thrown when a step paused on a gate has not yet been
 * approved — the pipeline halts and the CLI surfaces the gate name.
 *
 * Resuming is the operator's job: edit the primary artifact's frontmatter
 * `status` to `"approved"` (or use `isolator continue`, when it lands) and
 * re-run the pipeline; the gate then passes.
 */
export class PausedForApproval extends Error {
  override readonly name = "PausedForApproval";
  /** Gate name from the step config. */
  readonly gateName: string;
  /** The step result whose primary artifact is awaiting approval. */
  readonly result: StepResult;
  constructor(gateName: string, result: StepResult) {
    super(`Paused at gate "${gateName}" — approve the artifact to continue.`);
    this.gateName = gateName;
    this.result = result;
  }
}

/**
 * Pause the pipeline at a named gate until the step's primary artifact has
 * been marked `status: approved` in its frontmatter. A no-op when the
 * artifact is already approved.
 */
export const gate = async (name: string, result: StepResult): Promise<void> => {
  const frontmatter = await Effect.runPromise(
    readArtifactFrontmatter(result.artifactPath).pipe(
      Effect.provide(NodeContext.layer),
    ),
  ).catch(() => undefined);
  if (frontmatter?.status === "approved") return;
  throw new PausedForApproval(name, result);
};
