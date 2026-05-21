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
export { loadSkill, loadSkills, type Skill, SKILL_ENTRY } from "./skills.ts";
export {
  type CompiledContext,
  compileContext,
  type CompileContextOptions,
  type StagedContextFile,
} from "./context-compiler.ts";
export {
  composePrompt,
  OUTPUT_TAG,
  type PromptStackInputs,
} from "./prompt-stack.ts";
export {
  readArtifactFrontmatter,
  writeArtifact,
  type WriteArtifactOptions,
  writeContextManifest,
  type WrittenArtifact,
} from "./artifacts.ts";
export {
  runValidators,
  validators,
  type ValidationContext,
  type ValidationResult,
  type Validator,
} from "./contracts.ts";
export {
  appendRunRecord,
  readRunLog,
  renderTelemetry,
  rollupTelemetry,
  TELEMETRY_MD_PATH,
} from "./telemetry.ts";
export {
  gate,
  PausedForApproval,
  runStep,
  type RunStepOptions,
  type StepArtifact,
  type StepResult,
  type StepRunner,
} from "./run-step.ts";
export {
  ArtifactFrontmatter,
  ArtifactStatus,
  ConfigDefaults,
  ContextManifest,
  ContextManifestEntry,
  ContextPolicy,
  IsolatorConfig,
  ProjectEntry,
  ProjectOverview,
  ProjectStatus,
  RunRecord,
  StepConfig,
  StepOutput,
} from "./schemas.ts";
export {
  BASE_PROMPT_PATH,
  expandSlug,
  expandSlugs,
  globVault,
  readNote,
  RUNS_LOG_PATH,
  scaffoldVault,
  VAULT_DIRS,
  type VaultGlobMatch,
} from "./vault.ts";
