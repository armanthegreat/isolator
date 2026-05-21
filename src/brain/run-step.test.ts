import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatorHomeLayer, saveConfig } from "./config.ts";
import { runStep, type StepRunner } from "./run-step.ts";
import { scaffoldVault } from "./vault.ts";

/**
 * Set up an isolated brain: a temp `~/.isolator` home, a scaffolded vault, a
 * stand-in repo directory, and a `config.yml` registering project `demo`.
 */
const setup = async (): Promise<{
  home: string;
  vault: string;
  repo: string;
}> => {
  const home = await mkdtemp(join(tmpdir(), "isolator-home-"));
  const vault = await mkdtemp(join(tmpdir(), "isolator-vault-"));
  const repo = await mkdtemp(join(tmpdir(), "isolator-repo-"));

  await Effect.runPromise(
    scaffoldVault(vault).pipe(Effect.provide(NodeContext.layer)),
  );
  await Effect.runPromise(
    saveConfig({
      vault_path: vault,
      defaults: {},
      projects: { demo: { repo_path: repo } },
    }).pipe(
      Effect.provide(isolatorHomeLayer(home)),
      Effect.provide(NodeContext.layer),
    ),
  );

  return { home, vault, repo };
};

/** A fake `run()` that records its calls and returns canned output. */
const makeFakeRunner = (
  output: string,
): {
  runner: StepRunner;
  calls: Parameters<StepRunner>[0][];
} => {
  const calls: Parameters<StepRunner>[0][] = [];
  const runner: StepRunner = async (options) => {
    calls.push(options);
    return {
      iterations: [
        {
          usage: {
            inputTokens: 100,
            cacheCreationInputTokens: 5,
            cacheReadInputTokens: 15,
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

describe("runStep", () => {
  it("writes the agent output as an artifact in the vault", async () => {
    const { home, vault } = await setup();
    const { runner } = makeFakeRunner("ISOLATOR");

    const result = await runStep({
      project: "demo",
      id: "echo",
      prompt: "say the word",
      output: { type: "echo", path: "echo.md" },
      home,
      runner,
    });

    expect(result.success).toBe(true);
    expect(result.project).toBe("demo");
    expect(result.artifactPath).toBe(
      join(vault, "projects", "demo", "echo.md"),
    );
    expect(await readFile(result.artifactPath, "utf-8")).toBe("ISOLATOR\n");
  });

  it("appends a telemetry record to system/runs.jsonl", async () => {
    const { home, vault } = await setup();
    const { runner } = makeFakeRunner("ISOLATOR");

    const result = await runStep({
      project: "demo",
      id: "echo",
      prompt: "say the word",
      output: { type: "echo", path: "echo.md" },
      home,
      runner,
    });

    const log = await readFile(join(vault, "system", "runs.jsonl"), "utf-8");
    const lines = log.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record.run_id).toBe(result.runId);
    expect(record.project).toBe("demo");
    expect(record.step_id).toBe("echo");
    expect(record.success).toBe(true);
    expect(record.tokens_in).toBe(120);
    expect(record.tokens_out).toBe(20);
    expect(record.artifact_paths).toEqual([
      join("projects", "demo", "echo.md"),
    ]);
  });

  it("composes a prompt carrying the structured-output contract", async () => {
    const { home, repo } = await setup();
    const { runner, calls } = makeFakeRunner("ISOLATOR");

    await runStep({
      project: "demo",
      id: "echo",
      prompt: "say the word",
      output: { type: "echo", path: "echo.md" },
      home,
      runner,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.prompt).toContain("say the word");
    expect(call.prompt).toContain("<step_output>");
    expect(call.cwd).toBe(repo);
    expect(call.maxIterations).toBe(1);
  });

  it("throws when the project is not connected", async () => {
    const { home } = await setup();
    const { runner } = makeFakeRunner("ISOLATOR");

    await expect(
      runStep({
        project: "unknown",
        id: "echo",
        prompt: "say the word",
        output: { type: "echo", path: "echo.md" },
        home,
        runner,
      }),
    ).rejects.toThrow(/not connected/);
  });

  it("records a failed run and rethrows when the runner fails", async () => {
    const { home, vault } = await setup();
    const failingRunner: StepRunner = async () => {
      throw new Error("sandbox boom");
    };

    await expect(
      runStep({
        project: "demo",
        id: "echo",
        prompt: "say the word",
        output: { type: "echo", path: "echo.md" },
        home,
        runner: failingRunner,
      }),
    ).rejects.toThrow("sandbox boom");

    const log = await readFile(join(vault, "system", "runs.jsonl"), "utf-8");
    const record = JSON.parse(log.trim()) as Record<string, unknown>;
    expect(record.success).toBe(false);
    expect(record.artifact_paths).toEqual([]);
  });
});
