import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { join, resolve } from "node:path";
import { IsolatorHome, loadConfig, saveConfig } from "./config.ts";
import {
  BrainNotFoundError,
  ConfigInvalidError,
  type ConfigWriteError,
  InvalidSlugError,
  type ProjectExistsError,
  type ProjectWriteError,
  type RepoError,
  type VaultExistsError,
  type VaultWriteError,
} from "./errors.ts";
import { registerProject, scaffoldProject, toProjectSlug } from "./projects.ts";
import { createRepo, linkRepo, type RepoLink } from "./repo.ts";
import type { IsolatorConfig } from "./schemas.ts";
import { BASE_PROMPT_PATH, scaffoldVault } from "./vault.ts";

/**
 * Brain `init` orchestration — `createBrain` (scaffold a vault) and
 * `connectProject` (link a project to a brain). These tie together the vault,
 * repo, project-registry, and config modules; the CLI verbs are thin wrappers.
 */

/** Persist `vaultPath` as the configured brain, creating the config if absent. */
const setConfiguredVault = (
  vaultPath: string,
): Effect.Effect<
  void,
  ConfigInvalidError | ConfigWriteError,
  FileSystem.FileSystem | IsolatorHome
> =>
  Effect.gen(function* () {
    const existing = yield* loadConfig.pipe(
      Effect.catchTag("ConfigNotFoundError", () =>
        Effect.succeed<IsolatorConfig | undefined>(undefined),
      ),
    );
    yield* saveConfig(
      existing === undefined
        ? { vault_path: vaultPath, defaults: {}, projects: {} }
        : { ...existing, vault_path: vaultPath },
    );
  });

/** True when `vaultPath` points at an initialized brain vault. */
const isInitializedVault = (
  vaultPath: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs
      .exists(join(vaultPath, BASE_PROMPT_PATH))
      .pipe(Effect.catchAll(() => Effect.succeed(false)));
  });

/**
 * Scaffold a fresh brain vault at `dir` and record it as the configured brain
 * in `~/.isolator/config.yml`. Returns the absolute vault path.
 */
export const createBrain = (
  dir: string,
): Effect.Effect<
  string,
  VaultExistsError | VaultWriteError | ConfigInvalidError | ConfigWriteError,
  FileSystem.FileSystem | IsolatorHome
> =>
  Effect.gen(function* () {
    const vaultPath = yield* scaffoldVault(dir);
    yield* setConfiguredVault(vaultPath);
    return vaultPath;
  });

/** Inputs for {@link connectProject}. */
export interface ConnectOptions {
  /** Project name; normalized to a slug. */
  readonly name: string;
  /** Working directory relative paths (`--repo`, `--new-repo`) resolve against. */
  readonly cwd: string;
  /** `--brain`: path to an existing vault to connect to. */
  readonly brain?: string | undefined;
  /** `--new-brain`: path at which to scaffold a fresh vault. */
  readonly newBrain?: string | undefined;
  /** `--repo`: path to an existing source repo to link. */
  readonly repo?: string | undefined;
  /** `--new-repo`: path at which to create a fresh source repo. */
  readonly newRepo?: string | undefined;
}

/** Outcome of a successful {@link connectProject}. */
export interface ConnectResult {
  /** The project slug. */
  readonly slug: string;
  /** Absolute path of the brain vault the project was connected to. */
  readonly vaultPath: string;
  /** Absolute path of the scaffolded `projects/<slug>/` folder. */
  readonly projectDir: string;
  /** Absolute path of the project's source repo. */
  readonly repoPath: string;
  /** Whether a new brain vault was created as part of this connect. */
  readonly createdBrain: boolean;
}

/** Resolve which brain vault to connect to, per the `--brain`/`--new-brain` flags. */
const resolveBrain = (
  options: ConnectOptions,
): Effect.Effect<
  { readonly vaultPath: string; readonly created: boolean },
  | BrainNotFoundError
  | VaultExistsError
  | VaultWriteError
  | ConfigInvalidError
  | ConfigWriteError,
  FileSystem.FileSystem | IsolatorHome
> =>
  Effect.gen(function* () {
    if (options.newBrain !== undefined) {
      const vaultPath = yield* createBrain(
        resolve(options.cwd, options.newBrain),
      );
      return { vaultPath, created: true };
    }

    if (options.brain !== undefined) {
      const vaultPath = resolve(options.cwd, options.brain);
      if (!(yield* isInitializedVault(vaultPath))) {
        return yield* new BrainNotFoundError({
          message: `No brain vault at ${vaultPath}. Create one with \`isolator brain new ${options.brain}\`.`,
        });
      }
      yield* setConfiguredVault(vaultPath);
      return { vaultPath, created: false };
    }

    const config = yield* loadConfig.pipe(
      Effect.catchTag("ConfigNotFoundError", () =>
        Effect.succeed<IsolatorConfig | undefined>(undefined),
      ),
    );
    if (config === undefined) {
      return yield* new BrainNotFoundError({
        message:
          "No brain configured. Create one with `isolator brain new`, or pass --brain <path>.",
      });
    }
    if (!(yield* isInitializedVault(config.vault_path))) {
      return yield* new BrainNotFoundError({
        message: `Configured brain vault is missing at ${config.vault_path}. Recreate it with \`isolator brain new\` or pass --brain <path>.`,
      });
    }
    return { vaultPath: config.vault_path, created: false };
  });

/**
 * Connect a project to a brain: resolve the vault, create or link the source
 * repo, scaffold `projects/<slug>/` in the vault, and register the project's
 * machine-local repo path in `~/.isolator/config.yml`.
 *
 * The source repo is a plain code repo — no `.isolator/` is scaffolded;
 * orchestration is centralized in the brain, not per-project.
 */
export const connectProject = (
  options: ConnectOptions,
): Effect.Effect<
  ConnectResult,
  | BrainNotFoundError
  | VaultExistsError
  | VaultWriteError
  | ConfigInvalidError
  | ConfigWriteError
  | InvalidSlugError
  | ProjectExistsError
  | ProjectWriteError
  | RepoError,
  FileSystem.FileSystem | IsolatorHome
> =>
  Effect.gen(function* () {
    const slug = toProjectSlug(options.name);
    if (slug === "") {
      return yield* new InvalidSlugError({ slug: options.name });
    }

    const brain = yield* resolveBrain(options);

    const repo: RepoLink = yield* options.newRepo !== undefined
      ? createRepo(resolve(options.cwd, options.newRepo))
      : options.repo !== undefined
        ? linkRepo(resolve(options.cwd, options.repo))
        : createRepo(join(options.cwd, slug));

    const projectDir = yield* scaffoldProject({
      vaultPath: brain.vaultPath,
      slug,
      repoUrl: repo.repoUrl,
    });

    const config = yield* loadConfig.pipe(
      Effect.catchTag("ConfigNotFoundError", (cause) =>
        Effect.fail(
          new ConfigInvalidError({
            path: cause.path,
            message: "Config went missing mid-connect; re-run the command.",
          }),
        ),
      ),
    );
    yield* saveConfig(registerProject(config, slug, repo.path));

    return {
      slug,
      vaultPath: brain.vaultPath,
      projectDir,
      repoPath: repo.path,
      createdBrain: brain.created,
    };
  });
