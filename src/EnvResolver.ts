import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { homedir } from "node:os";
import { join } from "node:path";

const parseEnvFile = (
  filePath: string,
): Effect.Effect<Record<string, string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* fs
      .readFileString(filePath)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));
    if (content === null) return {};
    const vars: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      const isDoubleQuoted =
        value.length >= 2 &&
        value[0] === '"' &&
        value[value.length - 1] === '"';
      const isSingleQuoted =
        value.length >= 2 &&
        value[0] === "'" &&
        value[value.length - 1] === "'";
      if (isDoubleQuoted || isSingleQuoted) {
        value = value.slice(1, -1);
      }
      if (isDoubleQuoted) {
        value = value.replace(/\\([nrt\\])/g, (_, ch: string) => {
          const escapes: Record<string, string> = {
            n: "\n",
            r: "\r",
            t: "\t",
            "\\": "\\",
          };
          return escapes[ch] ?? ch;
        });
      }
      vars[key] = value;
    }
    return vars;
  });

/** Default home for the central env file — overrideable in tests. */
export const DEFAULT_ENV_PATH = (): string =>
  join(homedir(), ".isolator", ".env");

/**
 * Resolve env vars from the central `~/.isolator/.env`, with `process.env`
 * fallback for declared keys.
 *
 * Precedence: `~/.isolator/.env` > `process.env`. Only keys present in the
 * central env file appear in the result — `process.env` is *only* consulted as
 * a fallback for empty values of declared keys. This keeps the surface tight:
 * the file declares what gets forwarded.
 *
 * The `envPath` argument is a test seam; in production callers pass nothing
 * and {@link DEFAULT_ENV_PATH} is used.
 */
export const resolveEnv = (
  envPath?: string,
): Effect.Effect<Record<string, string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const path = envPath ?? DEFAULT_ENV_PATH();
    const declared = yield* parseEnvFile(path);

    const result: Record<string, string> = {};
    for (const key of Object.keys(declared)) {
      const value = declared[key] || process.env[key];
      if (value) {
        result[key] = value;
      }
    }

    return result;
  });
