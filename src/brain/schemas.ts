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

/**
 * Policy controlling how aggressively the context compiler stages files. Both
 * fields are optional; absent means "no cap" for that dimension.
 */
export const ContextPolicy = Schema.Struct({
  /** Maximum number of files to stage (excess are dropped lowest-priority first). */
  maxFiles: Schema.optional(Schema.Number),
  /** Approximate token budget; estimated as bytes/4. */
  maxTokens: Schema.optional(Schema.Number),
});
export type ContextPolicy = Schema.Schema.Type<typeof ContextPolicy>;

/**
 * A single artifact a step is expected to produce. `path` is project-relative
 * (under `projects/<slug>/`); `type` is a free-form label used by validators.
 */
export const StepOutput = Schema.Struct({
  /** Artifact type label, e.g. `"prd"`, `"open_questions"`. */
  type: Schema.NonEmptyString,
  /** Path within `projects/<slug>/`, e.g. `"prd/PRD.md"`. */
  path: Schema.NonEmptyString,
});
export type StepOutput = Schema.Schema.Type<typeof StepOutput>;

/**
 * The typed step contract — the brain's equivalent of isolator's
 * `RunOptions`. Drives `runStep()`; supersedes the ad-hoc `RunStepOptions`
 * once Phase 2 fully lands.
 */
export const StepConfig = Schema.Struct({
  /** Step id, e.g. `"prd"`. */
  id: Schema.NonEmptyString,
  /** Skill bundle name to load from `<vault>/skills/`. */
  skill: Schema.optional(Schema.NonEmptyString),
  /** Role file name (without `.md`) to load from `<vault>/roles/`. */
  role: Schema.optional(Schema.NonEmptyString),
  /** Sandbox image override. */
  image: Schema.optional(Schema.NonEmptyString),
  /** Branch strategy passed to `isolator.run()`. */
  worktree: Schema.optional(Schema.NonEmptyString),
  /** Vault globs to compile into staged context (supports `$slug`). */
  context: Schema.Array(Schema.NonEmptyString),
  /** Budget caps for the context compiler. */
  contextPolicy: Schema.optionalWith(ContextPolicy, { default: () => ({}) }),
  /** Artifacts the step is expected to produce. */
  output: Schema.Array(StepOutput),
  /** Names of validation predicates that must pass; resolved by `contracts.ts`. */
  validate: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => [],
  }),
  /** Approval gate name to pause on after success; absent → no gate. */
  gate: Schema.optional(Schema.NonEmptyString),
});
export type StepConfig = Schema.Schema.Type<typeof StepConfig>;

/**
 * One file included in a run's compiled context, recorded in the manifest.
 */
export const ContextManifestEntry = Schema.Struct({
  /** Vault-relative path of the staged file. */
  path: Schema.NonEmptyString,
  /** Glob that pulled the file in. */
  reason: Schema.NonEmptyString,
  /** Size of the staged file in bytes. */
  bytes: Schema.Number,
});
export type ContextManifestEntry = Schema.Schema.Type<
  typeof ContextManifestEntry
>;

/**
 * `context-manifest.yml` — the audit trail of which vault files were staged
 * for a run, why, and what was excluded by the budget. Written under
 * `projects/<slug>/runs/<run-id>/`.
 */
export const ContextManifest = Schema.Struct({
  /** Unique id of the run whose context this is. */
  run_id: Schema.NonEmptyString,
  /** Project slug. */
  project: Schema.NonEmptyString,
  /** Id of the step that compiled the context. */
  step_id: Schema.NonEmptyString,
  /** ISO-8601 timestamp the context was compiled. */
  compiled_at: Schema.NonEmptyString,
  /** Files staged into the run's context. */
  included: Schema.Array(ContextManifestEntry),
  /** A handful of paths that matched the globs but were dropped by the budget. */
  excluded_examples: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => [],
  }),
  /** Effective budget caps applied to this compilation. */
  budget: ContextPolicy,
});
export type ContextManifest = Schema.Schema.Type<typeof ContextManifest>;

/**
 * Lifecycle state of a single artifact, mirrored in its frontmatter.
 */
export const ArtifactStatus = Schema.Literal("draft", "approved", "superseded");
export type ArtifactStatus = Schema.Schema.Type<typeof ArtifactStatus>;

/**
 * The §11 artifact frontmatter — injected/repaired on every artifact written
 * back into the vault. Carries lineage (who produced it, in which run) and
 * lifecycle state.
 */
export const ArtifactFrontmatter = Schema.Struct({
  /** Stable artifact id (slug + type + variant). */
  artifact_id: Schema.NonEmptyString,
  /** Artifact type label, matches the step output's `type`. */
  artifact_type: Schema.NonEmptyString,
  /** Project slug the artifact belongs to. */
  project: Schema.NonEmptyString,
  /** Id of the step that produced this version. */
  produced_by: Schema.NonEmptyString,
  /** Id of the run that produced this version. */
  produced_in_run: Schema.NonEmptyString,
  /** Monotonic version counter; bumped on every regeneration. */
  version: Schema.Number,
  /** Lifecycle state. */
  status: ArtifactStatus,
  /** Whether the artifact must be approved at a gate before consumers may use it. */
  approval_required: Schema.optionalWith(Schema.Boolean, {
    default: () => false,
  }),
  /** ISO-8601 timestamp the artifact was approved; absent until then. */
  approved_at: Schema.optional(Schema.NonEmptyString),
  /** Who approved it (free-form). */
  approved_by: Schema.optional(Schema.NonEmptyString),
  /** Step ids that consume this artifact downstream. */
  consumers: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => [],
  }),
});
export type ArtifactFrontmatter = Schema.Schema.Type<
  typeof ArtifactFrontmatter
>;

/**
 * One run's telemetry record — serialized as a single JSON line in
 * `system/runs.jsonl`. Captures what ran, how much it cost, and what it
 * produced, so `telemetry.md` can later be rolled up from the log.
 */
export const RunRecord = Schema.Struct({
  /** Unique id of this run. */
  run_id: Schema.NonEmptyString,
  /** Project slug the run belongs to. */
  project: Schema.NonEmptyString,
  /** Id of the step that was run. */
  step_id: Schema.NonEmptyString,
  /** Agent provider id (e.g. `"claude-code"`). */
  agent: Schema.NonEmptyString,
  /** Model id the agent ran with. */
  model: Schema.NonEmptyString,
  /** Total input-side tokens (prompt + cache create + cache read). */
  tokens_in: Schema.Number,
  /** Total output tokens. */
  tokens_out: Schema.Number,
  /** Estimated cost in USD; absent until cost modeling lands. */
  cost_estimate: Schema.optional(Schema.Number),
  /** Wall-clock duration of the run in milliseconds. */
  duration_ms: Schema.Number,
  /** Whether the run succeeded. */
  success: Schema.Boolean,
  /** Names of validation predicates that passed; empty until contracts land. */
  validation_results: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => [],
  }),
  /** Vault-relative paths of the artifacts the run produced. */
  artifact_paths: Schema.Array(Schema.String),
  /** Vault-relative path of the run's context manifest; absent until the context compiler lands. */
  context_manifest_path: Schema.optional(Schema.String),
  /** ISO-8601 timestamp the run started. */
  started_at: Schema.NonEmptyString,
  /** ISO-8601 timestamp the run finished. */
  finished_at: Schema.NonEmptyString,
});
export type RunRecord = Schema.Schema.Type<typeof RunRecord>;
