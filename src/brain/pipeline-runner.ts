import { NodeContext } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { approveArtifact } from "./artifacts.ts";
import {
  defaultIsolatorHomeLayer,
  isolatorHomeLayer,
  loadConfig,
} from "./config.ts";
import {
  type ProjectOverviewPatch,
  toProjectSlug,
  updateProjectOverview,
} from "./projects.ts";
import { PausedForApproval, type StepResult } from "./run-step.ts";
import type { ProjectStatus } from "./schemas.ts";

/**
 * `runPipeline()` — the resume-aware pipeline driver behind `isolator pipeline`
 * and `isolator continue`.
 *
 * A pipeline is a plain re-runnable function (see `src/pipelines/`). There is
 * no engine: resume falls out of two facts —
 *
 * 1. `runStep()` short-circuits steps that already completed, so re-invoking a
 *    pipeline replays instantly up to the first unfinished step.
 * 2. `gate()` throws {@link PausedForApproval} while an artifact is unapproved.
 *
 * `runPipeline` ties those together. With `approveGate: false` (`pipeline`) it
 * runs once and reports a gate pause. With `approveGate: true` (`continue`) it
 * approves the artifact the pipeline paused on, then re-runs once — the
 * now-approved gate passes and the pipeline proceeds to the next gate or to
 * completion. Either way it mirrors the final state into `overview.md`.
 */

/** Terminal state of a {@link runPipeline} invocation. */
export type PipelineRunStatus = "completed" | "paused" | "failed";

/** Outcome of {@link runPipeline}. */
export interface PipelineRunOutcome {
  /** Project slug. */
  readonly project: string;
  /** Name of the pipeline that ran. */
  readonly pipelineName: string;
  /** Whether the pipeline finished, paused at a gate, or failed validation. */
  readonly runStatus: PipelineRunStatus;
  /** Lifecycle status written to `overview.md`. */
  readonly projectStatus: ProjectStatus;
  /** The most recent step result — the artifact reviewers act on. */
  readonly result: StepResult;
  /** Gate the pipeline is now paused on, when `runStatus` is `"paused"`. */
  readonly pausedGate?: string;
  /** Gate `continue` approved on this invocation before re-running, if any. */
  readonly approvedGate?: string;
}

/** A pipeline: drives a project through one or more brain steps. */
export type PipelineFn = (project: string) => Promise<StepResult>;

/** Inputs to {@link runPipeline}. */
export interface RunPipelineOptions {
  /** The pipeline function to run. */
  readonly pipeline: PipelineFn;
  /** Name the pipeline is registered under (recorded in `overview.md`). */
  readonly pipelineName: string;
  /** Project name or slug; normalized via {@link toProjectSlug}. */
  readonly project: string;
  /** When true (`isolator continue`), approve the paused gate and re-run. */
  readonly approveGate?: boolean;
  /** Override the `~/.isolator` home directory — test seam. */
  readonly home?: string;
}

/** Stringify an unknown thrown value. */
const errMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Run (or resume) a pipeline for a project, mirroring the result into
 * `overview.md`. Throws when the project is not connected or the pipeline
 * raises a non-gate error; a gate pause and a validation failure are reported
 * via the returned {@link PipelineRunOutcome}, not thrown.
 */
export const runPipeline = async (
  options: RunPipelineOptions,
): Promise<PipelineRunOutcome> => {
  const slug = toProjectSlug(options.project);
  if (slug === "") {
    throw new Error(`Invalid project name "${options.project}".`);
  }

  const homeLayer = options.home
    ? isolatorHomeLayer(options.home)
    : defaultIsolatorHomeLayer;
  const baseLayer = Layer.merge(homeLayer, NodeContext.layer);
  const fsLayer = NodeContext.layer;

  const config = await Effect.runPromise(
    loadConfig.pipe(Effect.provide(baseLayer)),
  ).catch((cause: unknown) => {
    throw new Error(`Could not load the isolator config: ${errMessage(cause)}`);
  });
  if (config.projects[slug] === undefined) {
    throw new Error(
      `Project "${slug}" is not connected. Run \`isolator connect ${slug}\` first.`,
    );
  }
  const vaultPath = config.vault_path;

  /** Mirror lifecycle state into `overview.md` — best-effort, never fatal. */
  const mirror = (patch: ProjectOverviewPatch): Promise<void> =>
    Effect.runPromise(
      updateProjectOverview(vaultPath, slug, patch).pipe(
        Effect.provide(fsLayer),
      ),
    )
      .then(() => undefined)
      .catch(() => undefined);

  /** One run of the pipeline; gate pauses come back as a value, not a throw. */
  const attempt = async (): Promise<
    | { readonly _tag: "result"; readonly result: StepResult }
    | { readonly _tag: "paused"; readonly pause: PausedForApproval }
  > => {
    try {
      return {
        _tag: "result",
        result: await options.pipeline(options.project),
      };
    } catch (cause) {
      if (cause instanceof PausedForApproval) {
        return { _tag: "paused", pause: cause };
      }
      await mirror({ status: "failed", blocker: errMessage(cause) });
      throw cause;
    }
  };

  /** Finalize a completed (or validation-failed) run. */
  const finalize = async (
    result: StepResult,
    approvedGate: string | undefined,
  ): Promise<PipelineRunOutcome> => {
    const projectStatus: ProjectStatus = result.success ? "done" : "failed";
    await mirror({
      status: projectStatus,
      pipeline: options.pipelineName,
      current_step: result.stepId,
      last_run_id: result.runId,
      blocker: result.success ? null : "Step finished with validation failures",
    });
    return {
      project: slug,
      pipelineName: options.pipelineName,
      runStatus: result.success ? "completed" : "failed",
      projectStatus,
      result,
      ...(approvedGate !== undefined && { approvedGate }),
    };
  };

  /** Finalize a gate pause. */
  const pausedOutcome = async (
    pause: PausedForApproval,
    approvedGate: string | undefined,
  ): Promise<PipelineRunOutcome> => {
    await mirror({
      status: "awaiting_approval",
      pipeline: options.pipelineName,
      current_step: pause.result.stepId,
      last_run_id: pause.result.runId,
      blocker: `Awaiting approval at gate "${pause.gateName}"`,
    });
    return {
      project: slug,
      pipelineName: options.pipelineName,
      runStatus: "paused",
      projectStatus: "awaiting_approval",
      result: pause.result,
      pausedGate: pause.gateName,
      ...(approvedGate !== undefined && { approvedGate }),
    };
  };

  // First pass.
  const first = await attempt();
  if (first._tag === "result") {
    return finalize(first.result, undefined);
  }

  // Paused at a gate. `isolator pipeline` stops here and reports it.
  if (options.approveGate !== true) {
    return pausedOutcome(first.pause, undefined);
  }

  // `isolator continue` — approve the paused artifact, then run once more.
  const approvedGate = first.pause.gateName;
  await Effect.runPromise(
    approveArtifact(first.pause.result.artifactPath).pipe(
      Effect.provide(fsLayer),
    ),
  ).catch((cause: unknown) => {
    throw new Error(
      `Could not approve gate "${approvedGate}": ${errMessage(cause)}`,
    );
  });

  const second = await attempt();
  return second._tag === "result"
    ? finalize(second.result, approvedGate)
    : pausedOutcome(second.pause, approvedGate);
};
