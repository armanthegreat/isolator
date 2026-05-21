/**
 * The brain — isolator's knowledge layer and typed step wrapper.
 *
 * All brain code lives under `src/brain/` (plus `src/pipelines/`) so isolator's
 * execution core stays untouched. This file is the public brain API surface.
 */

export {
  defaultIsolatorHomeLayer,
  IsolatorHome,
  isolatorHomeLayer,
  loadConfig,
} from "./config.ts";
export { ConfigInvalidError, ConfigNotFoundError } from "./errors.ts";
export { ConfigDefaults, IsolatorConfig, ProjectEntry } from "./schemas.ts";
