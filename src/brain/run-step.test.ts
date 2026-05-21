import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatorHomeLayer, saveConfig } from "./config.ts";
import {
  gate,
  PausedForApproval,
  runStep,
  type StepRunner,
} from "./run-step.ts";
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
    const written = await readFile(result.artifactPath, "utf-8");
    expect(written).toContain("artifact_type: echo");
    expect(written).toContain("version: 1");
    expect(written).toMatch(/---\n[\s\S]+?\n---\nISOLATOR\n/);
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

  it("writes a context manifest when context globs are supplied", async () => {
    const { home, vault } = await setup();
    await import("node:fs/promises").then((m) =>
      m.writeFile(join(vault, "rules", "scope.md"), "rule body", "utf8"),
    );
    const { runner } = makeFakeRunner("ECHO");

    const result = await runStep({
      project: "demo",
      id: "echo",
      prompt: "say",
      output: { type: "echo", path: "echo.md" },
      context: ["rules/**"],
      home,
      runner,
    });

    expect(result.contextManifestPath).toMatch(
      /runs\/.*\/context-manifest\.yml$/,
    );
    const manifest = await readFile(
      join(vault, result.contextManifestPath!),
      "utf8",
    );
    expect(manifest).toContain("scope.md");
  });

  it("runs validators and marks the step failed when one fails", async () => {
    const { home } = await setup();
    const { runner } = makeFakeRunner("ECHO");

    const result = await runStep({
      project: "demo",
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

    expect(result.success).toBe(false);
    expect(result.validation).toHaveLength(1);
    expect(result.validation[0]?.passed).toBe(false);
  });
});

describe("runStep short-circuit", () => {
  const echoStep = {
    project: "demo",
    id: "echo",
    prompt: "say the word",
    output: { type: "echo", path: "echo.md" },
  } as const;

  it("short-circuits a step that already completed successfully", async () => {
    const { home } = await setup();
    const { runner, calls } = makeFakeRunner("ISOLATOR");

    const first = await runStep({ ...echoStep, home, runner });
    expect(first.skipped).toBeUndefined();
    expect(calls).toHaveLength(1);

    const second = await runStep({ ...echoStep, home, runner });
    expect(second.skipped).toBe(true);
    expect(calls).toHaveLength(1); // the agent was not invoked again
    expect(second.runId).toBe(first.runId); // the prior run is reused
    expect(second.success).toBe(true);
    expect(second.artifactPath).toBe(first.artifactPath);

    // The artifact is reused, not regenerated — its version stays at 1.
    const written = await readFile(second.artifactPath, "utf-8");
    expect(written).toContain("version: 1");
  });

  it("re-runs a completed step when its artifact is gone", async () => {
    const { home, vault } = await setup();
    const { runner, calls } = makeFakeRunner("ISOLATOR");

    await runStep({ ...echoStep, home, runner });
    expect(calls).toHaveLength(1);

    await rm(join(vault, "projects", "demo", "echo.md"));

    const second = await runStep({ ...echoStep, home, runner });
    expect(calls).toHaveLength(2);
    expect(second.skipped).toBeUndefined();
  });

  it("re-runs a step whose only prior run failed", async () => {
    const { home } = await setup();
    const failingRunner: StepRunner = async () => {
      throw new Error("sandbox boom");
    };
    await expect(
      runStep({ ...echoStep, home, runner: failingRunner }),
    ).rejects.toThrow("sandbox boom");

    const { runner, calls } = makeFakeRunner("ISOLATOR");
    const second = await runStep({ ...echoStep, home, runner });
    expect(calls).toHaveLength(1); // the failed run did not block a retry
    expect(second.skipped).toBeUndefined();
    expect(second.success).toBe(true);
  });
});

describe("gate", () => {
  it("throws PausedForApproval when the artifact has not been approved", async () => {
    const { home } = await setup();
    const { runner } = makeFakeRunner("ECHO");

    const result = await runStep({
      project: "demo",
      id: "echo",
      prompt: "say",
      output: { type: "echo", path: "echo.md" },
      gate: "scope_approval",
      home,
      runner,
    });

    await expect(gate("scope_approval", result)).rejects.toBeInstanceOf(
      PausedForApproval,
    );
  });

  it("returns silently when the artifact has been approved", async () => {
    const { home } = await setup();
    const { runner } = makeFakeRunner("ECHO");

    const first = await runStep({
      project: "demo",
      id: "echo",
      prompt: "say",
      output: { type: "echo", path: "echo.md" },
      gate: "scope_approval",
      home,
      runner,
    });

    // Mark the artifact approved by rewriting its frontmatter.
    const { readFile: rf, writeFile: wf } = await import("node:fs/promises");
    const current = await rf(first.artifactPath, "utf8");
    await wf(
      first.artifactPath,
      current.replace("status: draft", "status: approved"),
      "utf8",
    );

    await expect(gate("scope_approval", first)).resolves.toBeUndefined();
  });
});
