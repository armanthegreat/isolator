import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readArtifactFrontmatter } from "./artifacts.ts";
import { isolatorHomeLayer, saveConfig } from "./config.ts";
import { type PipelineFn, runPipeline } from "./pipeline-runner.ts";
import { readProjectOverview, scaffoldProject } from "./projects.ts";
import { gate, runStep, type StepRunner } from "./run-step.ts";
import { scaffoldVault } from "./vault.ts";

const fs = NodeContext.layer;

/** A temp brain with the `demo` project scaffolded and connected. */
const setup = async (): Promise<{ home: string; vault: string }> => {
  const home = await mkdtemp(join(tmpdir(), "isolator-home-"));
  const vault = await mkdtemp(join(tmpdir(), "isolator-vault-"));
  const repo = await mkdtemp(join(tmpdir(), "isolator-repo-"));

  await Effect.runPromise(scaffoldVault(vault).pipe(Effect.provide(fs)));
  await Effect.runPromise(
    scaffoldProject({ vaultPath: vault, slug: "demo" }).pipe(
      Effect.provide(fs),
    ),
  );
  await Effect.runPromise(
    saveConfig({
      vault_path: vault,
      defaults: {},
      projects: { demo: { repo_path: repo, default_pipeline: "test" } },
    }).pipe(Effect.provide(isolatorHomeLayer(home)), Effect.provide(fs)),
  );
  return { home, vault };
};

/** A fake `run()` that counts its calls and returns canned output. */
const makeFakeRunner = (
  output: string,
): { runner: StepRunner; calls: { count: number } } => {
  const calls = { count: 0 };
  const runner: StepRunner = async () => {
    calls.count += 1;
    return {
      iterations: [
        {
          usage: {
            inputTokens: 100,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            outputTokens: 20,
          },
        },
      ],
      stdout: "fake stdout",
      commits: [],
      branch: "main",
      output,
    };
  };
  return { runner, calls };
};

/** A one-step pipeline with no gate. */
const echoPipeline =
  (home: string, runner: StepRunner): PipelineFn =>
  (project) =>
    runStep({
      project,
      id: "echo",
      prompt: "say",
      output: { type: "echo", path: "echo.md" },
      home,
      runner,
    });

/** A one-step pipeline guarded by a `scope_approval` gate. */
const gatedPipeline =
  (home: string, runner: StepRunner): PipelineFn =>
  async (project) => {
    const result = await runStep({
      project,
      id: "prd",
      prompt: "write the prd",
      output: { type: "prd", path: "PRD.md" },
      gate: "scope_approval",
      home,
      runner,
    });
    await gate("scope_approval", result);
    return result;
  };

const readOverview = (vault: string, slug: string) =>
  Effect.runPromise(readProjectOverview(vault, slug).pipe(Effect.provide(fs)));

const readFm = (absPath: string) =>
  Effect.runPromise(readArtifactFrontmatter(absPath).pipe(Effect.provide(fs)));

describe("runPipeline", () => {
  it("throws when the project is not connected", async () => {
    const { home } = await setup();
    const { runner } = makeFakeRunner("X");

    await expect(
      runPipeline({
        pipeline: echoPipeline(home, runner),
        pipelineName: "test",
        project: "ghost",
        home,
      }),
    ).rejects.toThrow(/not connected/);
  });

  it("completes a gateless pipeline and marks the project done", async () => {
    const { home, vault } = await setup();
    const { runner, calls } = makeFakeRunner("ISOLATOR");

    const outcome = await runPipeline({
      pipeline: echoPipeline(home, runner),
      pipelineName: "test",
      project: "demo",
      home,
    });

    expect(outcome.runStatus).toBe("completed");
    expect(outcome.projectStatus).toBe("done");
    expect(calls.count).toBe(1);

    const overview = await readOverview(vault, "demo");
    expect(overview?.status).toBe("done");
    expect(overview?.pipeline).toBe("test");
    expect(overview?.last_run_id).toBe(outcome.result.runId);
  });

  it("pauses at a gate without approving when approveGate is false", async () => {
    const { home, vault } = await setup();
    const { runner } = makeFakeRunner("PRD");

    const outcome = await runPipeline({
      pipeline: gatedPipeline(home, runner),
      pipelineName: "test",
      project: "demo",
      home,
    });

    expect(outcome.runStatus).toBe("paused");
    expect(outcome.pausedGate).toBe("scope_approval");
    expect(outcome.approvedGate).toBeUndefined();

    expect((await readOverview(vault, "demo"))?.status).toBe(
      "awaiting_approval",
    );
    // The artifact is left as a draft — the gate was not approved.
    expect((await readFm(outcome.result.artifactPath))?.status).toBe("draft");
  });

  it("approves the paused gate and completes when approveGate is true", async () => {
    const { home, vault } = await setup();
    const { runner, calls } = makeFakeRunner("PRD");

    // First pass pauses at the gate.
    await runPipeline({
      pipeline: gatedPipeline(home, runner),
      pipelineName: "test",
      project: "demo",
      home,
    });
    expect(calls.count).toBe(1);

    // `continue` approves the gate and resumes.
    const outcome = await runPipeline({
      pipeline: gatedPipeline(home, runner),
      pipelineName: "test",
      project: "demo",
      home,
      approveGate: true,
    });

    expect(outcome.runStatus).toBe("completed");
    expect(outcome.approvedGate).toBe("scope_approval");
    // The completed step short-circuited — the agent was not re-invoked.
    expect(calls.count).toBe(1);
    expect(outcome.result.skipped).toBe(true);
    expect((await readFm(outcome.result.artifactPath))?.status).toBe(
      "approved",
    );
    expect((await readOverview(vault, "demo"))?.status).toBe("done");
  });

  it("reports a validation failure as a failed run", async () => {
    const { home, vault } = await setup();
    const { runner } = makeFakeRunner("X");
    const failingPipeline: PipelineFn = (project) =>
      runStep({
        project,
        id: "echo",
        prompt: "say",
        output: { type: "echo", path: "echo.md" },
        outputs: [
          { type: "echo", path: "echo.md" },
          { type: "missing", path: "missing.md" },
        ],
        validate: ["all_required_outputs_exist"],
        home,
        runner,
      });

    const outcome = await runPipeline({
      pipeline: failingPipeline,
      pipelineName: "test",
      project: "demo",
      home,
    });

    expect(outcome.runStatus).toBe("failed");
    expect(outcome.projectStatus).toBe("failed");
    expect((await readOverview(vault, "demo"))?.status).toBe("failed");
  });
});
