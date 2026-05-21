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
