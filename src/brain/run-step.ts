import { NodeContext } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
  defaultIsolatorHomeLayer,
  isolatorHomeLayer,
  loadConfig,
} from "./config.ts";
import { toProjectSlug } from "./projects.ts";
import type { RunRecord } from "./schemas.ts";

/**
 * `runStep()` — the core brain primitive.
 *
 * isolator's unit is a raw `run()`; the brain's unit is a *brain-backed step*.
 * `runStep` resolves the project from `~/.isolator/config.yml`, composes a
 * prompt carrying a structured-output contract, runs the agent in a sandbox via
 * isolator's `run()`, writes the produced artifact back into the vault, and
 * appends a telemetry line to `system/runs.jsonl`.
 *
 * This is the minimal Phase-1 form: one artifact, an inline prompt, no context
 * compiler / prompt-stack / validators yet — those are layered on later.
 */

/** Default model when neither the step nor the config specifies one. */
const DEFAULT_MODEL = "claude-opus-4-7";

/** Env var the `claude` CLI reads for Pro/Max subscription auth. */
const OAUTH_TOKEN_KEY = "CLAUDE_CODE_OAUTH_TOKEN";

/** XML tag the agent wraps its result in; its contents become the artifact. */
const OUTPUT_TAG = "step_output";

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
  /** The single artifact this step produces. */
  readonly output: StepArtifact;
  /** Model override; defaults to config `defaults.model`, then `claude-opus-4-7`. */
  readonly model?: string;
  /** Docker image override; defaults to config `defaults.image`, then docker()'s repo-derived name. */
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
  /** Absolute path of the artifact written into the vault. */
  readonly artifactPath: string;
  /** Combined agent stdout. */
  readonly stdout: string;
  /** Whether the run succeeded. */
  readonly success: boolean;
}

/** Generate a sortable, unique run id. */
const makeRunId = (): string =>
  `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;

/** Wrap the step objective with the structured-output contract. */
const composePrompt = (objective: string): string =>
  `${objective}

## Output contract

When you have finished, emit your result wrapped in a single output tag:

<${OUTPUT_TAG}>
your result here
</${OUTPUT_TAG}>

Write nothing after the closing </${OUTPUT_TAG}> tag.`;

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

/** Append one telemetry record to the vault's `system/runs.jsonl`. */
const appendRunRecord = async (
  vaultPath: string,
  record: RunRecord,
): Promise<void> => {
  const logPath = join(vaultPath, "system", "runs.jsonl");
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(record)}\n`, "utf-8");
};

/**
 * Run a single brain-backed step end to end. Resolves the project, runs the
 * agent in a sandbox, writes the artifact into the vault, and records telemetry.
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

  const config = await Effect.runPromise(
    loadConfig.pipe(Effect.provide(Layer.merge(homeLayer, NodeContext.layer))),
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
  const model = options.model ?? config.defaults.model ?? DEFAULT_MODEL;
  const image = options.image ?? config.defaults.image;
  const token = await readOAuthToken(homeDir);
  const runner = options.runner ?? run;

  const runId = makeRunId();
  const startedAt = new Date().toISOString();
  const runDir = join(vaultPath, "projects", slug, "runs", runId);
  await mkdir(runDir, { recursive: true });

  let runResult: RunResult & { output: string };
  try {
    runResult = await runner({
      name: `brain:${slug}:${options.id}`,
      agent: claudeCode(
        model,
        token ? { env: { [OAUTH_TOKEN_KEY]: token } } : undefined,
      ),
      sandbox: docker(image ? { imageName: image } : undefined),
      cwd: projectEntry.repo_path,
      prompt: composePrompt(options.prompt),
      maxIterations: 1,
      logging: { type: "file", path: join(runDir, "agent.log") },
      output: Output.string({ tag: OUTPUT_TAG }),
    });
  } catch (cause) {
    await appendRunRecord(vaultPath, {
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
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    }).catch(() => undefined);
    throw cause;
  }

  const artifactRelPath = join("projects", slug, options.output.path);
  const artifactPath = join(vaultPath, artifactRelPath);
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${runResult.output}\n`, "utf-8");

  const tokens = sumTokens(runResult.iterations);
  await appendRunRecord(vaultPath, {
    run_id: runId,
    project: slug,
    step_id: options.id,
    agent: "claude-code",
    model,
    tokens_in: tokens.in,
    tokens_out: tokens.out,
    duration_ms: Date.now() - Date.parse(startedAt),
    success: true,
    validation_results: [],
    artifact_paths: [artifactRelPath],
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  });

  return {
    runId,
    stepId: options.id,
    project: slug,
    artifactPath,
    stdout: runResult.stdout,
    success: true,
  };
};
