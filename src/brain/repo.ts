import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { execFileSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { RepoError } from "./errors.ts";
import {
  type AgentEntry,
  type BacklogManagerEntry,
  renderDockerfile,
  type SandboxProviderEntry,
} from "./selectors.ts";

/**
 * Project source repos — the runnable-code half of a project. The brain never
 * stores code; `connect` either creates a fresh repo or links an existing one,
 * and records its path/remote so the vault folder can map to it.
 */

/** A project's source repo: its local path and (if any) its git remote URL. */
export interface RepoLink {
  /** Absolute path of the repo checkout. */
  readonly path: string;
  /** `origin` remote URL, or `undefined` when the repo has no remote. */
  readonly repoUrl: string | undefined;
}

/** Read the `origin` remote URL of a git repo, or `undefined` if there is none. */
const readOriginUrl = (repoPath: string): Effect.Effect<string | undefined> =>
  Effect.try(() =>
    execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim(),
  ).pipe(
    Effect.map((url) => (url.length > 0 ? url : undefined)),
    Effect.catchAll(() => Effect.succeed(undefined)),
  );

/**
 * Create a fresh project source repo at `dir`: `git init`, a `README.md`, and
 * an empty `design/` folder for design artifacts. Refuses a directory that
 * already has contents, so an existing repo is never disturbed.
 */
export const createRepo = (
  dir: string,
): Effect.Effect<RepoLink, RepoError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const repoPath = resolve(dir);

    const exists = yield* fs
      .exists(repoPath)
      .pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (exists) {
      const entries = yield* fs
        .readDirectory(repoPath)
        .pipe(Effect.catchAll(() => Effect.succeed<ReadonlyArray<string>>([])));
      if (entries.length > 0) {
        return yield* new RepoError({
          path: repoPath,
          message: `Cannot create a repo in a non-empty directory: ${repoPath}`,
        });
      }
    }

    const scaffold = Effect.gen(function* () {
      yield* fs.makeDirectory(repoPath, { recursive: true });
      yield* Effect.try(() =>
        execFileSync("git", ["init", "-q"], {
          cwd: repoPath,
          stdio: "ignore",
        }),
      );
      yield* fs.writeFileString(
        join(repoPath, "README.md"),
        `# ${basename(repoPath)}\n`,
      );
      yield* fs.makeDirectory(join(repoPath, "design"), { recursive: true });
      yield* fs.writeFileString(join(repoPath, "design", ".gitkeep"), "");
    });

    yield* scaffold.pipe(
      Effect.mapError(
        (cause) =>
          new RepoError({
            path: repoPath,
            message: `Could not create the project repo: ${cause}`,
          }),
      ),
    );

    return { path: repoPath, repoUrl: yield* readOriginUrl(repoPath) };
  });

/**
 * Inputs for {@link scaffoldDockerfile}: the agent, backlog manager, and
 * sandbox provider whose Dockerfile template + tool-snippet + filename combine
 * to produce the project's `.isolator/Dockerfile`.
 */
export interface ScaffoldDockerfileOptions {
  readonly repoPath: string;
  readonly agent: AgentEntry;
  readonly backlogManager: BacklogManagerEntry;
  readonly sandboxProvider: SandboxProviderEntry;
  /** When true, overwrite an existing Dockerfile; default false leaves it alone. */
  readonly overwrite?: boolean;
}

/**
 * Drop a `.isolator/<containerfile>` into a project's source repo, rendered
 * from the chosen agent + backlog manager templates. Idempotent by default:
 * if the file already exists, returns its path without rewriting it (a user
 * may have customized it). Pass `overwrite: true` to force a rewrite.
 *
 * Returns the absolute path of the written (or pre-existing) containerfile.
 */
export const scaffoldDockerfile = (
  options: ScaffoldDockerfileOptions,
): Effect.Effect<string, RepoError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { repoPath, agent, backlogManager, sandboxProvider, overwrite } =
      options;
    const configDir = join(repoPath, ".isolator");
    const target = join(configDir, sandboxProvider.containerfileName);

    const existing = yield* fs
      .exists(target)
      .pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (existing && overwrite !== true) return target;

    const write = Effect.gen(function* () {
      yield* fs.makeDirectory(configDir, { recursive: true });
      yield* fs.writeFileString(
        target,
        renderDockerfile(agent, backlogManager),
      );
    });

    yield* write.pipe(
      Effect.mapError(
        (cause) =>
          new RepoError({
            path: repoPath,
            message: `Could not write ${sandboxProvider.containerfileName}: ${cause}`,
          }),
      ),
    );
    return target;
  });

/**
 * Link an existing project source repo at `dir`. Validates the directory
 * exists and reads its `origin` remote URL when present.
 */
export const linkRepo = (
  dir: string,
): Effect.Effect<RepoLink, RepoError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const repoPath = resolve(dir);

    const info = yield* fs
      .stat(repoPath)
      .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    if (info === undefined || info.type !== "Directory") {
      return yield* new RepoError({
        path: repoPath,
        message: `No directory to link at ${repoPath}.`,
      });
    }

    return { path: repoPath, repoUrl: yield* readOriginUrl(repoPath) };
  });
