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
import {
  createRepo,
  linkRepo,
  type RepoLink,
  scaffoldDockerfile,
} from "./repo.ts";
import type { IsolatorConfig } from "./schemas.ts";
import {
  type AgentEntry,
  type BacklogManagerEntry,
  getAgent,
  getBacklogManager,
  getSandboxProvider,
  type SandboxProviderEntry,
} from "./selectors.ts";
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
  /** Agent provider id (e.g. `"claude-code"`). */
  readonly agent?: string | undefined;
  /** Model id override (e.g. `"claude-opus-4-7"`). */
  readonly model?: string | undefined;
  /** Sandbox provider id (e.g. `"docker"`, `"podman"`). */
  readonly sandbox?: string | undefined;
  /** Backlog manager id (e.g. `"github-issues"`). */
  readonly backlogManager?: string | undefined;
  /** Default pipeline name for this project (e.g. `"echo"`, `"discovery-to-prd"`). */
  readonly defaultPipeline?: string | undefined;
  /** Overwrite the project's `.isolator/<containerfile>` even if present; default false. */
  readonly overwriteDockerfile?: boolean | undefined;
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
  /** Absolute path of the project's containerfile (e.g. `<repo>/.isolator/Dockerfile`). */
  readonly dockerfilePath: string;
  /** The agent provider chosen for this project. */
  readonly agent: AgentEntry;
  /** The sandbox provider chosen for this project. */
  readonly sandboxProvider: SandboxProviderEntry;
  /** The backlog manager chosen for this project. */
  readonly backlogManager: BacklogManagerEntry;
  /** Model id chosen for this project. */
  readonly model: string;
  /** Default pipeline name (when one was selected). */
  readonly defaultPipeline?: string;
}

/** Default selectors when callers don't pass a flag (or interactive UX picks them). */
const DEFAULT_AGENT_ID = "claude-code";
const DEFAULT_SANDBOX_ID = "docker";
const DEFAULT_BACKLOG_MANAGER_ID = "github-issues";

/** Resolve agent/sandbox/backlog-manager ids to registry entries, with defaults. */
const resolveSelections = (
  options: ConnectOptions,
): {
  readonly agent: AgentEntry;
  readonly sandboxProvider: SandboxProviderEntry;
  readonly backlogManager: BacklogManagerEntry;
  readonly model: string;
} => {
  const agentId = options.agent ?? DEFAULT_AGENT_ID;
  const agent = getAgent(agentId);
  if (agent === undefined) {
    throw new Error(`Unknown agent "${agentId}"`);
  }
  const sandboxId = options.sandbox ?? DEFAULT_SANDBOX_ID;
  const sandboxProvider = getSandboxProvider(sandboxId);
  if (sandboxProvider === undefined) {
    throw new Error(`Unknown sandbox provider "${sandboxId}"`);
  }
  const backlogManagerId = options.backlogManager ?? DEFAULT_BACKLOG_MANAGER_ID;
  const backlogManager = getBacklogManager(backlogManagerId);
  if (backlogManager === undefined) {
    throw new Error(`Unknown backlog manager "${backlogManagerId}"`);
  }
  return {
    agent,
    sandboxProvider,
    backlogManager,
    model: options.model ?? agent.defaultModel,
  };
};

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

    const selections = resolveSelections(options);

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

    const dockerfilePath = yield* scaffoldDockerfile({
      repoPath: repo.path,
      agent: selections.agent,
      backlogManager: selections.backlogManager,
      sandboxProvider: selections.sandboxProvider,
      overwrite: options.overwriteDockerfile === true,
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
    yield* saveConfig(
      registerProject(config, slug, {
        repoPath: repo.path,
        agent: selections.agent.name,
        model: selections.model,
        sandbox: selections.sandboxProvider.name,
        backlogManager: selections.backlogManager.name,
        defaultPipeline: options.defaultPipeline,
      }),
    );

    return {
      slug,
      vaultPath: brain.vaultPath,
      projectDir,
      repoPath: repo.path,
      createdBrain: brain.created,
      dockerfilePath,
      agent: selections.agent,
      sandboxProvider: selections.sandboxProvider,
      backlogManager: selections.backlogManager,
      model: selections.model,
      defaultPipeline: options.defaultPipeline,
    };
  });
