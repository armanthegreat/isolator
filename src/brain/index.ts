/**
 * The brain — isolator's knowledge layer and typed step wrapper.
 *
 * All brain code lives under `src/brain/` (plus `src/pipelines/`) so isolator's
 * execution core stays untouched. This file is the public brain API surface.
 */

export {
  type ConnectOptions,
  type ConnectResult,
  connectProject,
  createBrain,
} from "./connect.ts";
export {
  defaultIsolatorHomeLayer,
  IsolatorHome,
  isolatorHomeLayer,
  loadConfig,
  saveConfig,
} from "./config.ts";
export {
  type BrainError,
  BrainNotFoundError,
  ConfigInvalidError,
  ConfigNotFoundError,
  ConfigWriteError,
  formatBrainError,
  InvalidSlugError,
  ProjectExistsError,
  ProjectWriteError,
  RepoError,
  VaultExistsError,
  VaultWriteError,
} from "./errors.ts";
export { createRepo, linkRepo, type RepoLink } from "./repo.ts";
export {
  registerProject,
  scaffoldProject,
  type ScaffoldProjectOptions,
  toProjectSlug,
} from "./projects.ts";
export {
  runStep,
  type RunStepOptions,
  type StepArtifact,
  type StepResult,
  type StepRunner,
} from "./run-step.ts";
export {
  ConfigDefaults,
  IsolatorConfig,
  ProjectEntry,
  ProjectOverview,
  ProjectStatus,
  RunRecord,
} from "./schemas.ts";
export {
  BASE_PROMPT_PATH,
  RUNS_LOG_PATH,
  scaffoldVault,
  VAULT_DIRS,
} from "./vault.ts";
