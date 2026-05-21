import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunRecord } from "./schemas.ts";
import {
  appendRunRecord,
  readRunLog,
  renderTelemetry,
  rollupTelemetry,
  TELEMETRY_MD_PATH,
} from "./telemetry.ts";

const makeTmp = () => mkdtemp(join(tmpdir(), "isolator-telemetry-"));

const seed = async (vault: string, files: Record<string, string>) => {
  await mkdir(vault, { recursive: true });
  for (const [relPath, contents] of Object.entries(files)) {
    const absolute = join(vault, relPath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }
};

const sampleRecord = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  run_id: "run-1",
  project: "demo",
  step_id: "prd",
  agent: "claude-code",
  model: "claude-opus-4-7",
  tokens_in: 1000,
  tokens_out: 100,
  duration_ms: 12_000,
  success: true,
  validation_results: [],
  artifact_paths: ["projects/demo/prd/PRD.md"],
  started_at: "2026-05-21T00:00:00.000Z",
  finished_at: "2026-05-21T00:00:12.000Z",
  ...overrides,
});

const provideFs = <Out, Err>(effect: Effect.Effect<Out, Err, unknown>) =>
  effect.pipe(Effect.provide(NodeContext.layer)) as Effect.Effect<Out, Err>;

describe("appendRunRecord + readRunLog", () => {
  it("appends a record and reads it back", async () => {
    const vault = join(await makeTmp(), "brain");
    await mkdir(vault, { recursive: true });

    await Effect.runPromise(provideFs(appendRunRecord(vault, sampleRecord())));
    const records = await Effect.runPromise(provideFs(readRunLog(vault)));

    expect(records).toHaveLength(1);
    expect(records[0]?.run_id).toBe("run-1");
  });

  it("appends multiple records in order", async () => {
    const vault = join(await makeTmp(), "brain");
    await mkdir(vault, { recursive: true });

    await Effect.runPromise(
      provideFs(appendRunRecord(vault, sampleRecord({ run_id: "run-1" }))),
    );
    await Effect.runPromise(
      provideFs(appendRunRecord(vault, sampleRecord({ run_id: "run-2" }))),
    );

    const records = await Effect.runPromise(provideFs(readRunLog(vault)));
    expect(records.map((r) => r.run_id)).toStrictEqual(["run-1", "run-2"]);
  });

  it("returns an empty array when the log is missing", async () => {
    const vault = join(await makeTmp(), "brain");
    await mkdir(vault, { recursive: true });

    const records = await Effect.runPromise(provideFs(readRunLog(vault)));
    expect(records).toStrictEqual([]);
  });

  it("skips malformed lines in the log", async () => {
    const vault = join(await makeTmp(), "brain");
    const goodLine = JSON.stringify(sampleRecord({ run_id: "good" }));
    await seed(vault, {
      "system/runs.jsonl": `${goodLine}\nnot-json\n${goodLine}\n`,
    });

    const records = await Effect.runPromise(provideFs(readRunLog(vault)));
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.run_id === "good")).toBe(true);
  });
});

describe("renderTelemetry", () => {
  it("renders totals, per-project, and recent runs", () => {
    const md = renderTelemetry([
      sampleRecord({ run_id: "r1", project: "demo" }),
      sampleRecord({
        run_id: "r2",
        project: "demo",
        success: false,
        tokens_in: 2000,
      }),
      sampleRecord({
        run_id: "r3",
        project: "other",
        started_at: "2026-05-20T00:00:00.000Z",
      }),
    ]);

    expect(md).toContain("# Brain telemetry");
    expect(md).toContain("**Runs:** 3");
    expect(md).toContain("**Successes:** 2");
    expect(md).toContain("**Failures:** 1");
    expect(md).toContain("| demo |");
    expect(md).toContain("| other |");
    expect(md.indexOf("r1")).toBeGreaterThanOrEqual(0);
    // most recent first in the tail
    expect(md.indexOf("r1")).toBeLessThan(md.indexOf("r3"));
  });

  it("omits sections that have no data", () => {
    const md = renderTelemetry([]);
    expect(md).toContain("**Runs:** 0");
    expect(md).not.toContain("## Per project");
    expect(md).not.toContain("## Most recent");
  });
});

describe("rollupTelemetry", () => {
  it("writes telemetry.md and returns the rendered text", async () => {
    const vault = join(await makeTmp(), "brain");
    await mkdir(vault, { recursive: true });
    await Effect.runPromise(provideFs(appendRunRecord(vault, sampleRecord())));

    const rendered = await Effect.runPromise(provideFs(rollupTelemetry(vault)));
    expect(rendered).toContain("**Runs:** 1");

    const onDisk = await readFile(join(vault, TELEMETRY_MD_PATH), "utf8");
    expect(onDisk).toBe(rendered);
  });
});
