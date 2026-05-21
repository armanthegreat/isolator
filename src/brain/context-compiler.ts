import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { join } from "node:path";
import { VaultReadError } from "./errors.ts";
import type { ContextManifest, ContextPolicy } from "./schemas.ts";
import { globVault, type VaultGlobMatch } from "./vault.ts";

/**
 * Curate a step's input context.
 *
 * isolator mounts the whole working repo into a sandbox; the brain adds
 * *curation*. The compiler globs the vault for the step's declared patterns,
 * measures each file, applies the step's file/token budget in glob order, and
 * returns:
 *
 *   - a `ContextManifest` ready to be written as `context-manifest.yml`, and
 *   - the staged file payload (path + bytes + UTF-8 contents) so callers can
 *     copy files to a stage directory and/or fold them into the prompt without
 *     a second round of reads.
 *
 * Token usage is approximated as `bytes / 4`. Good enough for budget
 * accounting; a real tokenizer can replace it later without changing the API.
 */

/** Approximate-tokens-per-byte heuristic — fine for English Markdown. */
const TOKENS_PER_BYTE = 1 / 4;

/** Maximum number of excluded paths to record in the manifest. */
const EXCLUDED_EXAMPLE_CAP = 8;

/** A single file staged into a run's context. */
export interface StagedContextFile {
  /** Vault-relative path. */
  readonly path: string;
  /** Pattern that pulled it in. */
  readonly reason: string;
  /** Size in bytes. */
  readonly bytes: number;
  /** UTF-8 contents, already read so the prompt-stack does not re-read. */
  readonly contents: string;
}

/** Inputs to {@link compileContext}. */
export interface CompileContextOptions {
  /** Absolute path to the vault. */
  readonly vaultPath: string;
  /** Project slug — used for `$slug` substitution in patterns. */
  readonly project: string;
  /** Step id (recorded in the manifest). */
  readonly stepId: string;
  /** Run id (recorded in the manifest). */
  readonly runId: string;
  /** Vault globs declaring what to include. */
  readonly patterns: readonly string[];
  /** Budget caps; missing fields mean unbounded. */
  readonly policy?: ContextPolicy;
  /** Override the compile timestamp — used for deterministic tests. */
  readonly now?: () => Date;
}

/** Outcome of a context compilation. */
export interface CompiledContext {
  /** Manifest ready to be serialized as `context-manifest.yml`. */
  readonly manifest: ContextManifest;
  /** Files staged for the run, in glob order. */
  readonly files: readonly StagedContextFile[];
  /** Vault-relative paths the budget dropped. */
  readonly excluded: readonly string[];
}

const estimateTokens = (bytes: number): number =>
  Math.ceil(bytes * TOKENS_PER_BYTE);

const withinBudget = (
  policy: ContextPolicy,
  fileCount: number,
  tokensSoFar: number,
  nextFileBytes: number,
): boolean => {
  if (policy.maxFiles !== undefined && fileCount + 1 > policy.maxFiles) {
    return false;
  }
  if (
    policy.maxTokens !== undefined &&
    tokensSoFar + estimateTokens(nextFileBytes) > policy.maxTokens
  ) {
    return false;
  }
  return true;
};

/**
 * Compile a step's context against the vault. Pure aside from the FileSystem
 * service; the orchestrator decides where to write the manifest and whether to
 * copy the staged files to disk.
 */
export const compileContext = (
  options: CompileContextOptions,
): Effect.Effect<CompiledContext, VaultReadError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const policy: ContextPolicy = options.policy ?? {};
    const now = options.now ?? (() => new Date());

    const matches: VaultGlobMatch[] = yield* globVault(
      options.vaultPath,
      options.patterns,
      { slug: options.project },
    );

    const included: StagedContextFile[] = [];
    const excluded: string[] = [];
    let tokens = 0;

    for (const match of matches) {
      const absolute = join(options.vaultPath, match.path);
      const contents = yield* fs.readFileString(absolute).pipe(
        Effect.mapError(
          (cause) =>
            new VaultReadError({
              path: absolute,
              message: `Could not read context file: ${cause}`,
            }),
        ),
      );
      const bytes = Buffer.byteLength(contents, "utf8");
      if (!withinBudget(policy, included.length, tokens, bytes)) {
        excluded.push(match.path);
        continue;
      }
      included.push({
        path: match.path,
        reason: match.reason,
        bytes,
        contents,
      });
      tokens += estimateTokens(bytes);
    }

    const manifest: ContextManifest = {
      run_id: options.runId,
      project: options.project,
      step_id: options.stepId,
      compiled_at: now().toISOString(),
      included: included.map(({ path, reason, bytes }) => ({
        path,
        reason,
        bytes,
      })),
      excluded_examples: excluded.slice(0, EXCLUDED_EXAMPLE_CAP),
      budget: policy,
    };

    return { manifest, files: included, excluded } satisfies CompiledContext;
  });
