import { FileSystem } from "@effect/platform";
import { Effect, Schema } from "effect";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { parseFrontmatter } from "./artifacts.ts";
import {
  InvalidSlugError,
  ProjectExistsError,
  ProjectWriteError,
  VaultReadError,
} from "./errors.ts";
import {
  type IsolatorConfig,
  type ProjectEntry,
  ProjectOverview,
  type ProjectStatus,
} from "./schemas.ts";

/**
 * Project registry — connecting a vault folder to a source code repo.
 *
 * The mapping is split: this module scaffolds the portable half
 * (`projects/<slug>/` in the vault, including `overview.md` frontmatter) and
 * derives the machine-local half (`IsolatorConfig.projects`). It does not
 * create or clone the code repo itself — that is the CLI's job.
 */

/** A valid project slug: hyphen-separated words of lowercase alphanumerics. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Normalize an arbitrary project name into a slug: lowercased, with runs of
 * non-alphanumeric characters collapsed to single hyphens and edge hyphens
 * trimmed. Returns `""` when nothing usable remains — callers should treat an
 * empty result as an invalid name.
 */
export const toProjectSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Body of a freshly scaffolded `overview.md`, below the frontmatter. */
const overviewBody = (slug: string): string =>
  `# ${slug}

Project overview. Edit in Obsidian or directly.

This vault folder links to the project's source repo: decision docs live here,
runnable code lives in the repo.
`;

/** Placeholder `discovery/idea.md` for the operator to fill in. */
const IDEA_STUB = `# Idea

Replace this with a one-paragraph description of the idea. The discovery-to-PRD
pipeline reads this file as its starting point — be concrete; rough is fine.
`;

/** Options for {@link scaffoldProject}. */
export interface ScaffoldProjectOptions {
  /** Absolute path to the brain vault. */
  readonly vaultPath: string;
  /** Project slug — must be valid kebab-case (see {@link toProjectSlug}). */
  readonly slug: string;
  /** Git remote URL of the source repo; omitted when no remote exists yet. */
  readonly repoUrl?: string;
}

/**
 * Scaffold `projects/<slug>/` in the vault: an `overview.md` with frontmatter
 * and a `discovery/idea.md` stub.
 *
 * Fails with `InvalidSlugError` for a malformed slug and `ProjectExistsError`
 * when the folder already exists, so an established project is never
 * overwritten. Returns the absolute path of the created project folder.
 */
export const scaffoldProject = (
  options: ScaffoldProjectOptions,
): Effect.Effect<
  string,
  InvalidSlugError | ProjectExistsError | ProjectWriteError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { vaultPath, slug, repoUrl } = options;

    if (!SLUG_PATTERN.test(slug)) {
      return yield* new InvalidSlugError({ slug });
    }

    const projectDir = join(vaultPath, "projects", slug);

    const exists = yield* fs
      .exists(projectDir)
      .pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (exists) {
      return yield* new ProjectExistsError({ slug, path: projectDir });
    }

    const overview: ProjectOverview =
      repoUrl !== undefined
        ? { project: slug, status: "active", repo_url: repoUrl }
        : { project: slug, status: "active" };

    const encoded = yield* Schema.encode(ProjectOverview)(overview).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectWriteError({
            slug,
            path: projectDir,
            message: `Could not encode overview frontmatter:\n${cause.message}`,
          }),
      ),
    );

    const overviewMd = `---\n${stringifyYaml(encoded)}---\n\n${overviewBody(slug)}`;

    const scaffold = Effect.gen(function* () {
      yield* fs.makeDirectory(join(projectDir, "discovery"), {
        recursive: true,
      });
      yield* fs.writeFileString(join(projectDir, "overview.md"), overviewMd);
      yield* fs.writeFileString(
        join(projectDir, "discovery", "idea.md"),
        IDEA_STUB,
      );
    });

    yield* scaffold.pipe(
      Effect.mapError(
        (cause) =>
          new ProjectWriteError({
            slug,
            path: projectDir,
            message: `Could not scaffold the project folder: ${cause}`,
          }),
      ),
    );

    return projectDir;
  });

/** Optional per-project settings persisted alongside `repo_path`. */
export interface ProjectRegistration {
  readonly repoPath: string;
  readonly agent?: string | undefined;
  readonly model?: string | undefined;
  readonly sandbox?: string | undefined;
  readonly backlogManager?: string | undefined;
  readonly defaultPipeline?: string | undefined;
}

/**
 * Return a copy of `config` with `slug` registered (or re-pointed) to its
 * machine-local code-repo checkout and per-project defaults. Pure — the caller
 * persists the result with `saveConfig`. Undefined fields are omitted from the
 * stored entry so the YAML stays compact.
 */
export const registerProject = (
  config: IsolatorConfig,
  slug: string,
  registration: ProjectRegistration,
): IsolatorConfig => {
  const entry: ProjectEntry = {
    repo_path: registration.repoPath,
    ...(registration.agent !== undefined && { agent: registration.agent }),
    ...(registration.model !== undefined && { model: registration.model }),
    ...(registration.sandbox !== undefined && {
      sandbox: registration.sandbox,
    }),
    ...(registration.backlogManager !== undefined && {
      backlog_manager: registration.backlogManager,
    }),
    ...(registration.defaultPipeline !== undefined && {
      default_pipeline: registration.defaultPipeline,
    }),
  };
  return {
    ...config,
    projects: { ...config.projects, [slug]: entry },
  };
};

/** Filename of a project's overview note inside `projects/<slug>/`. */
export const OVERVIEW_FILE = "overview.md";

/**
 * Read and decode a project's `overview.md` frontmatter — the portable,
 * machine-independent project record.
 *
 * Returns `undefined` when the file is missing or carries no decodable
 * frontmatter (so callers can report "not found" without special-casing IO);
 * only a genuine read failure surfaces as `VaultReadError`.
 */
export const readProjectOverview = (
  vaultPath: string,
  slug: string,
): Effect.Effect<
  ProjectOverview | undefined,
  VaultReadError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const absPath = join(vaultPath, "projects", slug, OVERVIEW_FILE);
    const exists = yield* fs
      .exists(absPath)
      .pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (!exists) return undefined;
    const text = yield* fs.readFileString(absPath).pipe(
      Effect.mapError(
        (cause) =>
          new VaultReadError({
            path: absPath,
            message: `Could not read project overview: ${cause}`,
          }),
      ),
    );
    const parsed = parseFrontmatter(text);
    if (parsed === undefined) return undefined;
    try {
      return Schema.decodeUnknownSync(ProjectOverview)(parsed.frontmatter);
    } catch {
      return undefined;
    }
  });

/**
 * A patch for {@link updateProjectOverview}. An absent key is left untouched;
 * an explicit `null` clears an optional field; `status` is required and so
 * can only be set, never cleared.
 */
export interface ProjectOverviewPatch {
  readonly status?: ProjectStatus;
  readonly pipeline?: string | null;
  readonly current_step?: string | null;
  readonly last_run_id?: string | null;
  readonly blocker?: string | null;
  readonly repo_url?: string | null;
}

/** Optional `overview.md` fields a patch may set or clear. */
const PATCHABLE_FIELDS = [
  "pipeline",
  "current_step",
  "last_run_id",
  "blocker",
  "repo_url",
] as const;

/** Apply a patch to a decoded overview — pure; see {@link ProjectOverviewPatch}. */
const applyOverviewPatch = (
  current: ProjectOverview,
  patch: ProjectOverviewPatch,
): ProjectOverview => {
  const next: Record<string, unknown> = { ...current };
  if (patch.status !== undefined) next["status"] = patch.status;
  for (const key of PATCHABLE_FIELDS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next as ProjectOverview;
};

/**
 * Patch a project's `overview.md` frontmatter in place, preserving the note
 * body. This is how pipelines record lifecycle state — `status`,
 * `current_step`, `last_run_id`, `blocker` — so `isolator status` can report it.
 *
 * Fails with `VaultReadError` when `overview.md` cannot be read and
 * `ProjectWriteError` when it has no decodable frontmatter or the write fails.
 * Returns the updated overview.
 */
export const updateProjectOverview = (
  vaultPath: string,
  slug: string,
  patch: ProjectOverviewPatch,
): Effect.Effect<
  ProjectOverview,
  VaultReadError | ProjectWriteError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const absPath = join(vaultPath, "projects", slug, OVERVIEW_FILE);

    const text = yield* fs.readFileString(absPath).pipe(
      Effect.mapError(
        (cause) =>
          new VaultReadError({
            path: absPath,
            message: `Could not read project overview: ${cause}`,
          }),
      ),
    );
    const parsed = parseFrontmatter(text);
    if (parsed === undefined) {
      return yield* new ProjectWriteError({
        slug,
        path: absPath,
        message: "overview.md has no frontmatter — cannot update it.",
      });
    }
    const current = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(ProjectOverview)(parsed.frontmatter),
      catch: (cause) =>
        new ProjectWriteError({
          slug,
          path: absPath,
          message: `overview.md frontmatter is invalid:\n${cause}`,
        }),
    });

    const next = applyOverviewPatch(current, patch);
    const encoded = yield* Schema.encode(ProjectOverview)(next).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectWriteError({
            slug,
            path: absPath,
            message: `Could not encode overview frontmatter:\n${cause.message}`,
          }),
      ),
    );

    const body = parsed.body.replace(/^\n+/, "");
    const overviewMd = `---\n${stringifyYaml(encoded)}---\n\n${body}`;
    yield* fs.writeFileString(absPath, overviewMd).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectWriteError({
            slug,
            path: absPath,
            message: `Could not write project overview: ${cause}`,
          }),
      ),
    );
    return next;
  });
