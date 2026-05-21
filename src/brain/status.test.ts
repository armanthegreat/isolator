import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatorHomeLayer, saveConfig } from "./config.ts";
import { scaffoldProject, updateProjectOverview } from "./projects.ts";
import type { RunRecord } from "./schemas.ts";
import { projectStatus } from "./status.ts";
import { appendRunRecord } from "./telemetry.ts";
import { scaffoldVault } from "./vault.ts";

const fs = NodeContext.layer;

/** A temp brain: `~/.isolator` home, a scaffolded vault, and a config. */
const setup = async (
  opts: { connect?: boolean } = {},
): Promise<{ home: string; vault: string; repo: string }> => {
  const home = await mkdtemp(join(tmpdir(), "isolator-home-"));
  const vault = await mkdtemp(join(tmpdir(), "isolator-vault-"));
  const repo = await mkdtemp(join(tmpdir(), "isolator-repo-"));

  await Effect.runPromise(scaffoldVault(vault).pipe(Effect.provide(fs)));
  await Effect.runPromise(
    saveConfig({
      vault_path: vault,
      defaults: {},
      projects:
        opts.connect === false
          ? {}
          : { demo: { repo_path: repo, default_pipeline: "echo" } },
    }).pipe(Effect.provide(isolatorHomeLayer(home)), Effect.provide(fs)),
  );

  return { home, vault, repo };
};

const record = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  run_id: "run-1",
  project: "demo",
  step_id: "echo",
  agent: "claude-code",
  model: "claude-opus-4-7",
  tokens_in: 100,
  tokens_out: 20,
  duration_ms: 1234,
  success: true,
  validation_results: [],
  artifact_paths: ["projects/demo/echo.md"],
  started_at: "2026-05-21T00:00:00.000Z",
  finished_at: "2026-05-21T00:00:01.234Z",
  ...overrides,
});

describe("projectStatus", () => {
  it("throws when the project is not connected", async () => {
    const { home } = await setup({ connect: false });

    await expect(projectStatus({ project: "demo", home })).rejects.toThrow(
      /not connected/,
    );
  });

  it("reports a connected project with no overview or runs", async () => {
    const { home, repo } = await setup();

    const report = await projectStatus({ project: "demo", home });
    expect(report.project).toBe("demo");
    expect(report.repoPath).toBe(repo);
    expect(report.entry.default_pipeline).toBe("echo");
    expect(report.overview).toBeUndefined();
    expect(report.lastRun).toBeUndefined();
  });

  it("joins overview frontmatter and the most recent run", async () => {
    const { home, vault } = await setup();
    await Effect.runPromise(
      scaffoldProject({ vaultPath: vault, slug: "demo" }).pipe(
        Effect.provide(fs),
      ),
    );
    await Effect.runPromise(
      updateProjectOverview(vault, "demo", {
        status: "awaiting_approval",
        pipeline: "discovery-to-prd",
        blocker: 'Awaiting approval at gate "scope_approval"',
      }).pipe(Effect.provide(fs)),
    );
    await Effect.runPromise(
      appendRunRecord(vault, record({ run_id: "run-old" })).pipe(
        Effect.provide(fs),
      ),
    );
    await Effect.runPromise(
      appendRunRecord(vault, record({ run_id: "run-new" })).pipe(
        Effect.provide(fs),
      ),
    );

    const report = await projectStatus({ project: "demo", home });
    expect(report.overview?.status).toBe("awaiting_approval");
    expect(report.overview?.blocker).toContain("scope_approval");
    expect(report.lastRun?.run_id).toBe("run-new");
  });

  it("ignores runs belonging to other projects", async () => {
    const { home, vault } = await setup();
    await Effect.runPromise(
      appendRunRecord(
        vault,
        record({ run_id: "other", project: "elsewhere" }),
      ).pipe(Effect.provide(fs)),
    );

    const report = await projectStatus({ project: "demo", home });
    expect(report.lastRun).toBeUndefined();
  });
});
