import type { StepResult } from "../brain/run-step.ts";
import { echo } from "./echo.ts";

/**
 * Pipelines — brain-driven, repeatable software-development sequences.
 *
 * A pipeline is a plain TS function: it takes a project slug, calls one or more
 * `runStep()`s, and returns the final step result. Parallel/conditional/fan-out
 * logic is just TypeScript — there is no YAML engine. The CLI verb
 * `isolator pipeline <name> <project>` looks the function up in {@link pipelines}.
 */

/** An async function driving a project through one or more brain steps. */
export type Pipeline = (project: string) => Promise<StepResult>;

/** Registry of runnable pipelines, keyed by the name used on the CLI. */
export const pipelines: Record<string, Pipeline> = {
  echo,
};
