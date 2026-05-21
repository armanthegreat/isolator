import { Schema } from "effect";

/**
 * A project's machine-local entry in `~/.isolator/config.yml`.
 *
 * The vault↔code-repo mapping is split: the machine-independent git remote URL
 * lives in the vault (`overview.md` frontmatter); this is the machine-specific
 * half — where the project's source repo is checked out on *this* machine.
 */
export const ProjectEntry = Schema.Struct({
  /** Absolute path to the project's source-code checkout on this machine. */
  repo_path: Schema.NonEmptyString,
});
export type ProjectEntry = Schema.Schema.Type<typeof ProjectEntry>;

/**
 * Run defaults applied by pipelines/steps that do not specify their own.
 * Every field is optional; an absent `defaults` block decodes to `{}`.
 */
export const ConfigDefaults = Schema.Struct({
  /** Default agent provider id (e.g. `"claude-code"`). */
  agent: Schema.optional(Schema.NonEmptyString),
  /** Default model id (e.g. `"claude-opus-4-7"`). */
  model: Schema.optional(Schema.NonEmptyString),
  /** Default sandbox image. */
  image: Schema.optional(Schema.NonEmptyString),
});
export type ConfigDefaults = Schema.Schema.Type<typeof ConfigDefaults>;

/**
 * Lifecycle state of a project, mirrored in `overview.md` frontmatter.
 *
 * `awaiting_approval` — paused at a gate; `awaiting_input` — paused on
 * unanswered open questions; `done`/`failed` — terminal.
 */
export const ProjectStatus = Schema.Literal(
  "active",
  "awaiting_approval",
  "awaiting_input",
  "done",
  "failed",
);
export type ProjectStatus = Schema.Schema.Type<typeof ProjectStatus>;

/**
 * The frontmatter of a project's `overview.md` in the vault — the portable,
 * machine-independent half of the project record (the machine-local checkout
 * path lives in `IsolatorConfig.projects`).
 */
export const ProjectOverview = Schema.Struct({
  /** Project slug; matches the `projects/<slug>/` folder name. */
  project: Schema.NonEmptyString,
  /** Lifecycle state. */
  status: ProjectStatus,
  /** Git remote URL of the source repo; absent until a remote is set. */
  repo_url: Schema.optional(Schema.NonEmptyString),
  /** Pipeline currently driving the project (e.g. `"discovery-to-prd"`). */
  pipeline: Schema.optional(Schema.NonEmptyString),
  /** Id of the step the pipeline is at. */
  current_step: Schema.optional(Schema.NonEmptyString),
  /** Id of the most recent run. */
  last_run_id: Schema.optional(Schema.NonEmptyString),
  /** Human-readable reason the project is blocked, when paused. */
  blocker: Schema.optional(Schema.NonEmptyString),
});
export type ProjectOverview = Schema.Schema.Type<typeof ProjectOverview>;

/**
 * The central isolator config — `~/.isolator/config.yml`.
 *
 * Holds the machine-specific state the portable brain vault deliberately does
 * not: where the vault is checked out, run defaults, and the per-project
 * code-repo paths.
 */
export const IsolatorConfig = Schema.Struct({
  /** Absolute path to the brain vault on this machine. */
  vault_path: Schema.NonEmptyString,
  /** Run defaults; absent in the file → `{}`. */
  defaults: Schema.optionalWith(ConfigDefaults, { default: () => ({}) }),
  /** Per-project machine-local mappings, keyed by project slug; absent → `{}`. */
  projects: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: ProjectEntry }),
    { default: () => ({}) },
  ),
});
export type IsolatorConfig = Schema.Schema.Type<typeof IsolatorConfig>;
