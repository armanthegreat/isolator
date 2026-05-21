import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import fastGlob from "fast-glob";
import { join, posix, resolve } from "node:path";
import { SkillError } from "./errors.ts";

/**
 * Skill loader. A skill lives at `<vault>/skills/<id>/` and must contain a
 * `SKILL.md` — its main prompt body. Any other files in the bundle are
 * sidecars (templates, examples) the orchestrator can stage alongside the
 * skill when running a step.
 *
 * This module is read-only — staging into `.isolator/staged/<run-id>/skills/`
 * is the orchestrator's job (`run-step.ts`).
 */

/** The required entry-point file of every skill bundle. */
export const SKILL_ENTRY = "SKILL.md";

/** A loaded skill bundle — markdown body plus discovered sidecars. */
export interface Skill {
  /** Skill id, matches the folder name under `<vault>/skills/`. */
  readonly id: string;
  /** Absolute path of the skill folder. */
  readonly path: string;
  /** Contents of `SKILL.md`. */
  readonly markdown: string;
  /** Vault-relative paths of every non-entry file in the bundle, in glob order. */
  readonly sidecars: readonly string[];
}

const skillsRoot = (vaultPath: string): string =>
  join(resolve(vaultPath), "skills");

/**
 * Load a skill bundle by id. Returns the markdown body plus the
 * vault-relative paths of every sidecar file in the folder.
 *
 * Failures (missing folder, missing `SKILL.md`, unreadable files) are
 * surfaced as a single `SkillError`.
 */
export const loadSkill = (
  vaultPath: string,
  skillId: string,
): Effect.Effect<Skill, SkillError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = resolve(vaultPath);
    const skillDir = join(skillsRoot(vaultPath), skillId);
    const entryPath = join(skillDir, SKILL_ENTRY);

    const hasEntry = yield* fs
      .exists(entryPath)
      .pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (!hasEntry) {
      return yield* new SkillError({
        skill: skillId,
        path: skillDir,
        message: `No ${SKILL_ENTRY} found at ${skillDir}.`,
      });
    }

    const markdown = yield* fs.readFileString(entryPath).pipe(
      Effect.mapError(
        (cause) =>
          new SkillError({
            skill: skillId,
            path: entryPath,
            message: `Could not read ${SKILL_ENTRY}: ${cause}`,
          }),
      ),
    );

    const allFiles = yield* Effect.tryPromise({
      try: () =>
        fastGlob("**/*", {
          cwd: skillDir,
          dot: false,
          onlyFiles: true,
          followSymbolicLinks: false,
        }),
      catch: (cause) =>
        new SkillError({
          skill: skillId,
          path: skillDir,
          message: `Could not list skill bundle: ${cause}`,
        }),
    });

    const sidecars = allFiles
      .filter((relPath) => relPath !== SKILL_ENTRY)
      .map((relPath) => posix.join("skills", skillId, relPath))
      .sort();

    return {
      id: skillId,
      path: skillDir,
      markdown,
      sidecars,
    } satisfies Skill;
  });

/**
 * Load several skills in declaration order, short-circuiting on the first
 * failure. Convenience wrapper for steps that compose multiple skills.
 */
export const loadSkills = (
  vaultPath: string,
  skillIds: readonly string[],
): Effect.Effect<Skill[], SkillError, FileSystem.FileSystem> =>
  Effect.all(skillIds.map((id) => loadSkill(vaultPath, id)));
