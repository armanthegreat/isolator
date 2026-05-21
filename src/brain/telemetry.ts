import { FileSystem } from "@effect/platform";
import { Effect, Schema } from "effect";
import { dirname, join } from "node:path";
import { VaultReadError, VaultWriteError } from "./errors.ts";
import { RunRecord } from "./schemas.ts";
import { RUNS_LOG_PATH } from "./vault.ts";

/**
 * Run telemetry.
 *
 * Every brain run appends a `RunRecord` JSON line to
 * `<vault>/system/runs.jsonl`. That file is the source of truth — small,
 * append-only, easy to grep. A human-readable `system/telemetry.md` is
 * derived from it on demand: totals across all runs, per-project rollups,
 * and a short tail of the most recent runs.
 *
 * Keeping the log + rollup separate means the rollup can be regenerated at
 * any time without losing data.
 */

/** Path of the derived rollup file, relative to the vault root. */
export const TELEMETRY_MD_PATH = join("system", "telemetry.md");

/** How many of the most recent runs the rollup lists in full. */
const TAIL_SIZE = 10;

const decodeRecord = Schema.decodeUnknownSync(RunRecord);

/**
 * Append a `RunRecord` to `system/runs.jsonl`. Creates the file (and the
 * `system/` directory) when missing.
 */
export const appendRunRecord = (
  vaultPath: string,
  record: RunRecord,
): Effect.Effect<void, VaultWriteError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const absPath = join(vaultPath, RUNS_LOG_PATH);
    yield* fs.makeDirectory(dirname(absPath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new VaultWriteError({
            path: absPath,
            message: `Could not create telemetry directory: ${cause}`,
          }),
      ),
    );
    const encoded = Schema.encodeUnknownSync(RunRecord)(record);
    const line = `${JSON.stringify(encoded)}\n`;
    const existing = yield* fs
      .readFileString(absPath)
      .pipe(Effect.catchAll(() => Effect.succeed("")));
    yield* fs.writeFileString(absPath, existing + line).pipe(
      Effect.mapError(
        (cause) =>
          new VaultWriteError({
            path: absPath,
            message: `Could not append run record: ${cause}`,
          }),
      ),
    );
  });

/**
 * Read every `RunRecord` from `system/runs.jsonl`. Malformed lines are
 * skipped silently — the log must remain readable even after a partial
 * write — and a missing file returns an empty array.
 */
export const readRunLog = (
  vaultPath: string,
): Effect.Effect<RunRecord[], VaultReadError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const absPath = join(vaultPath, RUNS_LOG_PATH);
    const exists = yield* fs
      .exists(absPath)
      .pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (!exists) return [];
    const text = yield* fs.readFileString(absPath).pipe(
      Effect.mapError(
        (cause) =>
          new VaultReadError({
            path: absPath,
            message: `Could not read runs log: ${cause}`,
          }),
      ),
    );
    const records: RunRecord[] = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        records.push(decodeRecord(JSON.parse(line)));
      } catch {
        // skip malformed lines
      }
    }
    return records;
  });

interface ProjectRollup {
  readonly project: string;
  readonly runs: number;
  readonly successes: number;
  readonly failures: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

const rollupByProject = (records: readonly RunRecord[]): ProjectRollup[] => {
  const buckets = new Map<string, ProjectRollup>();
  for (const record of records) {
    const prev = buckets.get(record.project) ?? {
      project: record.project,
      runs: 0,
      successes: 0,
      failures: 0,
      tokensIn: 0,
      tokensOut: 0,
    };
    buckets.set(record.project, {
      project: record.project,
      runs: prev.runs + 1,
      successes: prev.successes + (record.success ? 1 : 0),
      failures: prev.failures + (record.success ? 0 : 1),
      tokensIn: prev.tokensIn + record.tokens_in,
      tokensOut: prev.tokensOut + record.tokens_out,
    });
  }
  return [...buckets.values()].sort((a, b) =>
    a.project.localeCompare(b.project),
  );
};

const fmtNumber = (n: number): string => n.toLocaleString("en-US");

/**
 * Render telemetry as a human-readable Markdown document. Pure — no IO; the
 * orchestrator decides when to call it and where to write the result.
 */
export const renderTelemetry = (records: readonly RunRecord[]): string => {
  const total = records.length;
  const successes = records.filter((r) => r.success).length;
  const failures = total - successes;
  const tokensIn = records.reduce((sum, r) => sum + r.tokens_in, 0);
  const tokensOut = records.reduce((sum, r) => sum + r.tokens_out, 0);

  const projects = rollupByProject(records);
  const tail = [...records]
    .sort((a, b) =>
      a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0,
    )
    .slice(0, TAIL_SIZE);

  const lines: string[] = [];
  lines.push("# Brain telemetry");
  lines.push("");
  lines.push(
    "_Derived from `system/runs.jsonl` — regenerate after every run._",
  );
  lines.push("");

  lines.push("## Totals");
  lines.push("");
  lines.push(`- **Runs:** ${fmtNumber(total)}`);
  lines.push(`- **Successes:** ${fmtNumber(successes)}`);
  lines.push(`- **Failures:** ${fmtNumber(failures)}`);
  lines.push(`- **Tokens in:** ${fmtNumber(tokensIn)}`);
  lines.push(`- **Tokens out:** ${fmtNumber(tokensOut)}`);
  lines.push("");

  if (projects.length > 0) {
    lines.push("## Per project");
    lines.push("");
    lines.push(
      "| Project | Runs | Successes | Failures | Tokens in | Tokens out |",
    );
    lines.push("|---|---:|---:|---:|---:|---:|");
    for (const p of projects) {
      lines.push(
        `| ${p.project} | ${fmtNumber(p.runs)} | ${fmtNumber(p.successes)} | ${fmtNumber(p.failures)} | ${fmtNumber(p.tokensIn)} | ${fmtNumber(p.tokensOut)} |`,
      );
    }
    lines.push("");
  }

  if (tail.length > 0) {
    lines.push(`## Most recent (${tail.length})`);
    lines.push("");
    lines.push(
      "| Started | Project | Step | Run | Success | Tokens (in/out) |",
    );
    lines.push("|---|---|---|---|:---:|---:|");
    for (const r of tail) {
      lines.push(
        `| ${r.started_at} | ${r.project} | ${r.step_id} | ${r.run_id} | ${r.success ? "✓" : "✗"} | ${fmtNumber(r.tokens_in)} / ${fmtNumber(r.tokens_out)} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
};

/**
 * Read `runs.jsonl`, render the rollup, and write it to `system/telemetry.md`.
 * Returns the rendered Markdown so callers can show / commit it directly.
 */
export const rollupTelemetry = (
  vaultPath: string,
): Effect.Effect<
  string,
  VaultReadError | VaultWriteError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const records = yield* readRunLog(vaultPath);
    const rendered = renderTelemetry(records);
    const absPath = join(vaultPath, TELEMETRY_MD_PATH);
    yield* fs.makeDirectory(dirname(absPath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new VaultWriteError({
            path: absPath,
            message: `Could not create telemetry directory: ${cause}`,
          }),
      ),
    );
    yield* fs.writeFileString(absPath, rendered).pipe(
      Effect.mapError(
        (cause) =>
          new VaultWriteError({
            path: absPath,
            message: `Could not write telemetry rollup: ${cause}`,
          }),
      ),
    );
    return rendered;
  });
