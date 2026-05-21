import { FileSystem } from "@effect/platform";
import { Context, Effect, Layer, Schema } from "effect";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  ConfigInvalidError,
  ConfigNotFoundError,
  ConfigWriteError,
} from "./errors.ts";
import { IsolatorConfig } from "./schemas.ts";

/**
 * The `~/.isolator` home directory — where the central config (`config.yml`)
 * and host auth (`.env`) live.
 *
 * Provided as an Effect layer so tests can point it at a temp directory
 * without the production code taking an optional path parameter.
 */
export class IsolatorHome extends Context.Tag("IsolatorHome")<
  IsolatorHome,
  { readonly dir: string }
>() {}

/** Build an `IsolatorHome` layer pointing at an explicit directory. */
export const isolatorHomeLayer = (dir: string): Layer.Layer<IsolatorHome> =>
  Layer.succeed(IsolatorHome, { dir });

/** Default `IsolatorHome` layer — `~/.isolator`. */
export const defaultIsolatorHomeLayer: Layer.Layer<IsolatorHome> = Layer.sync(
  IsolatorHome,
  () => ({ dir: join(homedir(), ".isolator") }),
);

/** Filename of the central config inside the isolator home directory. */
const CONFIG_FILENAME = "config.yml";

/**
 * Load and validate the central isolator config (`~/.isolator/config.yml`).
 *
 * Fails with `ConfigNotFoundError` when the file is absent (the brain has not
 * been initialized) and `ConfigInvalidError` when it cannot be read, is not
 * valid YAML, or does not match the `IsolatorConfig` schema.
 */
export const loadConfig: Effect.Effect<
  IsolatorConfig,
  ConfigNotFoundError | ConfigInvalidError,
  IsolatorHome | FileSystem.FileSystem
> = Effect.gen(function* () {
  const home = yield* IsolatorHome;
  const fs = yield* FileSystem.FileSystem;
  const path = join(home.dir, CONFIG_FILENAME);

  const exists = yield* fs
    .exists(path)
    .pipe(Effect.catchAll(() => Effect.succeed(false)));
  if (!exists) {
    return yield* new ConfigNotFoundError({ path });
  }

  const content = yield* fs.readFileString(path).pipe(
    Effect.mapError(
      (cause) =>
        new ConfigInvalidError({
          path,
          message: `Could not read config file: ${cause}`,
        }),
    ),
  );

  const parsed = yield* Effect.try({
    try: () => parseYaml(content) as unknown,
    catch: (cause) =>
      new ConfigInvalidError({
        path,
        message: `Config is not valid YAML: ${cause}`,
      }),
  });

  return yield* Schema.decodeUnknown(IsolatorConfig)(parsed).pipe(
    Effect.mapError(
      (cause) =>
        new ConfigInvalidError({
          path,
          message: `Config does not match the expected shape:\n${cause.message}`,
        }),
    ),
  );
});

/**
 * Write the central isolator config (`~/.isolator/config.yml`), creating the
 * isolator home directory if it does not exist. Overwrites any existing file.
 *
 * The config is schema-encoded before serialization so a malformed value is
 * caught here rather than on the next {@link loadConfig}. Fails with
 * `ConfigWriteError` when encoding, directory creation, or the write fails.
 */
export const saveConfig = (
  config: IsolatorConfig,
): Effect.Effect<
  void,
  ConfigWriteError,
  IsolatorHome | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const home = yield* IsolatorHome;
    const fs = yield* FileSystem.FileSystem;
    const path = join(home.dir, CONFIG_FILENAME);

    const encoded = yield* Schema.encode(IsolatorConfig)(config).pipe(
      Effect.mapError(
        (cause) =>
          new ConfigWriteError({
            path,
            message: `Config does not match the expected shape:\n${cause.message}`,
          }),
      ),
    );

    yield* fs.makeDirectory(home.dir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ConfigWriteError({
            path,
            message: `Could not create the isolator home directory: ${cause}`,
          }),
      ),
    );

    yield* fs.writeFileString(path, stringifyYaml(encoded)).pipe(
      Effect.mapError(
        (cause) =>
          new ConfigWriteError({
            path,
            message: `Could not write config file: ${cause}`,
          }),
      ),
    );
  });
