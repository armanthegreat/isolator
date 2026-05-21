import { Data } from "effect";

/**
 * The central config file (`~/.isolator/config.yml`) does not exist — the
 * brain has not been initialized on this machine yet.
 */
export class ConfigNotFoundError extends Data.TaggedError(
  "ConfigNotFoundError",
)<{
  /** Absolute path the config file was expected at. */
  readonly path: string;
}> {}

/**
 * The central config file exists but could not be read, is not valid YAML, or
 * does not match the `IsolatorConfig` schema.
 */
export class ConfigInvalidError extends Data.TaggedError("ConfigInvalidError")<{
  /** Absolute path of the offending config file. */
  readonly path: string;
  /** Human-readable explanation of why the config could not be loaded. */
  readonly message: string;
}> {}

/**
 * The central config file could not be written — the isolator home directory
 * could not be created, or the file write itself failed.
 */
export class ConfigWriteError extends Data.TaggedError("ConfigWriteError")<{
  /** Absolute path the config file was being written to. */
  readonly path: string;
  /** Human-readable explanation of why the config could not be written. */
  readonly message: string;
}> {}

/**
 * A brain vault already exists at the target path — `brain new` refuses to
 * scaffold over an initialized vault.
 */
export class VaultExistsError extends Data.TaggedError("VaultExistsError")<{
  /** Absolute path of the already-initialized vault. */
  readonly path: string;
}> {}

/**
 * A brain vault could not be scaffolded — a directory or file write failed.
 */
export class VaultWriteError extends Data.TaggedError("VaultWriteError")<{
  /** Absolute path of the vault being scaffolded. */
  readonly path: string;
  /** Human-readable explanation of why scaffolding failed. */
  readonly message: string;
}> {}

/**
 * A project slug is empty or not in `kebab-case` of lowercase alphanumerics.
 */
export class InvalidSlugError extends Data.TaggedError("InvalidSlugError")<{
  /** The rejected slug. */
  readonly slug: string;
}> {}

/**
 * A project folder already exists in the vault — connecting refuses to
 * scaffold over an existing `projects/<slug>/`.
 */
export class ProjectExistsError extends Data.TaggedError("ProjectExistsError")<{
  /** Slug of the conflicting project. */
  readonly slug: string;
  /** Absolute path of the already-existing project folder. */
  readonly path: string;
}> {}

/**
 * A project folder could not be scaffolded — a directory or file write failed.
 */
export class ProjectWriteError extends Data.TaggedError("ProjectWriteError")<{
  /** Slug of the project being scaffolded. */
  readonly slug: string;
  /** Absolute path of the project folder. */
  readonly path: string;
  /** Human-readable explanation of why scaffolding failed. */
  readonly message: string;
}> {}

/**
 * A project source repository could not be created or linked.
 */
export class RepoError extends Data.TaggedError("RepoError")<{
  /** Absolute path of the repo directory. */
  readonly path: string;
  /** Human-readable explanation of the failure. */
  readonly message: string;
}> {}

/**
 * No brain vault could be resolved — none is configured and none was passed,
 * or the given path is not an initialized vault.
 */
export class BrainNotFoundError extends Data.TaggedError("BrainNotFoundError")<{
  /** Human-readable explanation, including how to recover. */
  readonly message: string;
}> {}

/** Every error the brain layer can raise. */
export type BrainError =
  | ConfigNotFoundError
  | ConfigInvalidError
  | ConfigWriteError
  | VaultExistsError
  | VaultWriteError
  | InvalidSlugError
  | ProjectExistsError
  | ProjectWriteError
  | RepoError
  | BrainNotFoundError;

/** Render a brain error as a single user-facing line for the CLI. */
export const formatBrainError = (error: BrainError): string => {
  switch (error._tag) {
    case "ConfigNotFoundError":
      return `No isolator config found at ${error.path}.`;
    case "ConfigInvalidError":
    case "ConfigWriteError":
    case "VaultWriteError":
    case "ProjectWriteError":
    case "RepoError":
    case "BrainNotFoundError":
      return error.message;
    case "VaultExistsError":
      return `A brain vault already exists at ${error.path}.`;
    case "InvalidSlugError":
      return `Invalid project name "${error.slug}" — use letters and numbers.`;
    case "ProjectExistsError":
      return `Project "${error.slug}" already exists at ${error.path}.`;
  }
};
