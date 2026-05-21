import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import fastGlob from "fast-glob";
import { join, resolve } from "node:path";
import { VaultExistsError, VaultReadError, VaultWriteError } from "./errors.ts";

/**
 * The brain vault — a global, shared Obsidian-style Markdown repo holding
 * skills, roles, rules, and per-project notes. It contains no source code; a
 * project links a vault folder to a separate code repo.
 *
 * This module owns scaffolding a fresh vault (`brain new`). Reading and
 * globbing notes is the concern of later modules (`context-compiler`).
 */

/** Top-level directories every brain vault contains. */
export const VAULT_DIRS = [
  "system",
  "skills",
  "roles",
  "rules",
  "projects",
] as const;

/**
 * Vault directories that start empty. Each gets a `.gitkeep` so the directory
 * survives a `git add` — `system/` is excluded because it ships real files.
 */
const GITKEEP_DIRS = ["skills", "roles", "rules", "projects"] as const;

/** Path of the base system prompt, relative to the vault root. */
export const BASE_PROMPT_PATH = join("system", "base.md");

/** Path of the append-only run telemetry log, relative to the vault root. */
export const RUNS_LOG_PATH = join("system", "runs.jsonl");

/**
 * The shared prelude prepended to every brain step's prompt. Kept deliberately
 * small — anything step-specific belongs in a skill, role, or rule.
 */
const BASE_PROMPT_CONTENT = `# Base system prompt

This file is the shared prelude prepended to every brain step's prompt. Keep it
small and universal — anything step-specific belongs in a skill, role, or rule.

## Operating principles

- Do exactly what the step's objective and output contract ask — no more, no
  less.
- Produce every artifact listed in the output contract, at the exact path given.
- Never fabricate facts, citations, APIs, or file contents. If something is
  unknown, say so or raise it as an open question.
- Prefer evidence from the staged context over assumption.
- When uncertain about scope, record the uncertainty rather than guessing.
`;

/** Top-level README explaining what the vault is. */
const VAULT_README = `# Brain vault

This is an isolator **brain vault** — a global, shared Markdown repo of skills,
roles, rules, and per-project notes. It holds no source code.

- \`system/\` — \`base.md\` (shared prompt prelude) and \`runs.jsonl\` (telemetry).
- \`skills/\` — \`SKILL.md\` bundles.
- \`roles/\` — role definitions.
- \`rules/\` — shared rules.
- \`projects/\` — per-project notes (\`projects/<slug>/\`), created on connect.

Open this folder in Obsidian, or edit the Markdown directly.
`;

/**
 * Scaffold a fresh brain vault at `dir`.
 *
 * Creates the directory tree, the base system prompt, an empty telemetry log,
 * and a README. Idempotent directory creation makes a partially-created vault
 * recoverable, but an already-initialized vault (one with `system/base.md`) is
 * refused with `VaultExistsError` rather than overwritten.
 *
 * Returns the resolved absolute vault path — ready to record as `vault_path`
 * in `~/.isolator/config.yml`.
 */
export const scaffoldVault = (
  dir: string,
): Effect.Effect<
  string,
  VaultExistsError | VaultWriteError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const vaultDir = resolve(dir);

    const alreadyInitialized = yield* fs
      .exists(join(vaultDir, BASE_PROMPT_PATH))
      .pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (alreadyInitialized) {
      return yield* new VaultExistsError({ path: vaultDir });
    }

    const scaffold = Effect.gen(function* () {
      for (const subdir of VAULT_DIRS) {
        yield* fs.makeDirectory(join(vaultDir, subdir), { recursive: true });
      }
      yield* fs.writeFileString(
        join(vaultDir, BASE_PROMPT_PATH),
        BASE_PROMPT_CONTENT,
      );
      yield* fs.writeFileString(join(vaultDir, RUNS_LOG_PATH), "");
      yield* fs.writeFileString(join(vaultDir, "README.md"), VAULT_README);
      for (const subdir of GITKEEP_DIRS) {
        yield* fs.writeFileString(join(vaultDir, subdir, ".gitkeep"), "");
      }
    });

    yield* scaffold.pipe(
      Effect.mapError(
        (cause) =>
          new VaultWriteError({
            path: vaultDir,
            message: `Could not scaffold the vault: ${cause}`,
          }),
      ),
    );

    return vaultDir;
  });

/**
 * Substitute `$slug` placeholders in a glob pattern. Used so step `context`
 * patterns like `"projects/$slug/discovery/**"` stay portable across projects.
 */
export const expandSlug = (pattern: string, slug: string): string =>
  pattern.replaceAll("$slug", slug);

/**
 * Substitute `$slug` in every pattern of an array, preserving order.
 */
export const expandSlugs = (
  patterns: readonly string[],
  slug: string,
): string[] => patterns.map((pattern) => expandSlug(pattern, slug));

/**
 * Read a single vault file by its vault-relative path, returning UTF-8 text.
 *
 * Failures (missing file, permission denied) are surfaced as a `VaultReadError`
 * with the absolute path; callers can decide whether to fall back or stop.
 */
export const readNote = (
  vaultPath: string,
  relPath: string,
): Effect.Effect<string, VaultReadError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const absolute = join(resolve(vaultPath), relPath);
    return yield* fs.readFileString(absolute).pipe(
      Effect.mapError(
        (cause) =>
          new VaultReadError({
            path: absolute,
            message: `Could not read vault note: ${cause}`,
          }),
      ),
    );
  });

/** Result of a vault glob: vault-relative paths in the order fast-glob returns them. */
export interface VaultGlobMatch {
  /** Vault-relative path of the matched file. */
  readonly path: string;
  /** Pattern that pulled it in (so the manifest can record provenance). */
  readonly reason: string;
}

/**
 * Glob the vault. Patterns are vault-relative and run through `$slug`
 * substitution when `slug` is given. Each match remembers the pattern that
 * pulled it in, so the context manifest can record why a file was staged.
 *
 * Duplicates are folded: if multiple patterns match the same file, the *first*
 * pattern that matched is recorded as its reason.
 */
export const globVault = (
  vaultPath: string,
  patterns: readonly string[],
  options: { readonly slug?: string } = {},
): Effect.Effect<VaultGlobMatch[], VaultReadError> =>
  Effect.gen(function* () {
    const root = resolve(vaultPath);
    const expanded = options.slug
      ? expandSlugs(patterns, options.slug)
      : [...patterns];

    const matches = new Map<string, string>();
    for (const pattern of expanded) {
      const found = yield* Effect.tryPromise({
        try: () =>
          fastGlob(pattern, {
            cwd: root,
            dot: false,
            onlyFiles: true,
            followSymbolicLinks: false,
          }),
        catch: (cause) =>
          new VaultReadError({
            path: root,
            message: `Could not glob "${pattern}": ${cause}`,
          }),
      });
      for (const path of found) {
        if (!matches.has(path)) matches.set(path, pattern);
      }
    }

    return [...matches].map(([path, reason]) => ({ path, reason }));
  });
