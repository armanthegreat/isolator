import { NodeContext } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import {
  defaultIsolatorHomeLayer,
  isolatorHomeLayer,
  loadConfig,
} from "./config.ts";
import { readProjectOverview, toProjectSlug } from "./projects.ts";
import type { ProjectEntry, ProjectOverview, RunRecord } from "./schemas.ts";
import { readRunLog } from "./telemetry.ts";

/**
 * `projectStatus()` — the read side of the brain CLI.
 *
 * It answers "where is this project?" by joining the two halves of a project's
 * record: the machine-local `ProjectEntry` from `~/.isolator/config.yml` and
 * the portable `overview.md` frontmatter from the vault, plus the most recent
 * `runs.jsonl` line. `isolator status` renders the result; `isolator continue`
 * reuses it to resolve which pipeline to resume.
 */

/** Inputs to {@link projectStatus}. */
export interface StatusOptions {
  /** Project name or slug; normalized via {@link toProjectSlug}. */
  readonly project: string;
  /** Override the `~/.isolator` home directory — test seam. */
  readonly home?: string;
}

/** A project's current state, joined from config, vault, and telemetry. */
export interface StatusReport {
  /** Project slug. */
  readonly project: string;
  /** Absolute path to the project's source-code checkout on this machine. */
  readonly repoPath: string;
  /** The machine-local config entry (agent/model/sandbox/default pipeline). */
  readonly entry: ProjectEntry;
  /** Decoded `overview.md` frontmatter; absent when the note is missing. */
  readonly overview?: ProjectOverview;
  /** The most recent run for this project; absent when none have run. */
  readonly lastRun?: RunRecord;
}

/**
 * Resolve a connected project's status. Throws when the project name is
 * invalid, the config cannot be loaded, or the project is not connected — the
 * CLI maps those to a friendly error.
 */
export const projectStatus = async (
  options: StatusOptions,
): Promise<StatusReport> => {
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
    throw new Error(
      `Could not load the isolator config: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  });

  const entry = config.projects[slug];
  if (entry === undefined) {
    throw new Error(
      `Project "${slug}" is not connected. Run \`isolator connect ${slug}\` first.`,
    );
  }

  const vaultPath = config.vault_path;
  const overview = await Effect.runPromise(
    readProjectOverview(vaultPath, slug).pipe(Effect.provide(fsLayer)),
  ).catch(() => undefined);

  const runs = await Effect.runPromise(
    readRunLog(vaultPath).pipe(Effect.provide(fsLayer)),
  ).catch(() => [] as RunRecord[]);
  const lastRun = runs.filter((record) => record.project === slug).at(-1);

  return {
    project: slug,
    repoPath: entry.repo_path,
    entry,
    overview,
    lastRun,
  };
};
