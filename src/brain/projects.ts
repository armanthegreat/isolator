import { FileSystem } from "@effect/platform";
import { Effect, Schema } from "effect";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  InvalidSlugError,
  ProjectExistsError,
  ProjectWriteError,
} from "./errors.ts";
import { type IsolatorConfig, ProjectOverview } from "./schemas.ts";

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

/**
 * Return a copy of `config` with `slug` registered (or re-pointed) to its
 * machine-local code-repo checkout. Pure — the caller persists the result with
 * `saveConfig`.
 */
export const registerProject = (
  config: IsolatorConfig,
  slug: string,
  repoPath: string,
): IsolatorConfig => ({
  ...config,
  projects: { ...config.projects, [slug]: { repo_path: repoPath } },
});
