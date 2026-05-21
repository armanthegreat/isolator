import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeArtifact, writeContextManifest } from "./artifacts.ts";
import {
  runValidators,
  validators,
  type ValidationContext,
} from "./contracts.ts";
import type { ContextManifest, StepOutput } from "./schemas.ts";

const makeTmp = () => mkdtemp(join(tmpdir(), "isolator-contracts-"));

const seed = async (vault: string, files: Record<string, string>) => {
  await mkdir(vault, { recursive: true });
  for (const [relPath, contents] of Object.entries(files)) {
    const absolute = join(vault, relPath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }
};

const ctx = (
  vault: string,
  overrides: Partial<ValidationContext> = {},
): ValidationContext => ({
  vaultPath: vault,
  project: "demo",
  runId: "run-1",
  outputs: [{ type: "prd", path: "prd/PRD.md" }],
  ...overrides,
});

const runWithFs = <Out>(
  effect: Effect.Effect<Out, never, unknown>,
): Promise<Out> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(NodeContext.layer)) as Effect.Effect<Out>,
  );

const writeFrontmatterArtifact = async (
  vault: string,
  output: StepOutput,
  body: string,
) =>
  Effect.runPromise(
    writeArtifact({
      vaultPath: vault,
      project: "demo",
      stepId: "prd",
      runId: "run-1",
      output,
      body,
    }).pipe(Effect.provide(NodeContext.layer)),
  );

describe("validators.all_required_outputs_exist", () => {
  it("passes when every declared artifact exists", async () => {
    const vault = join(await makeTmp(), "brain");
    await seed(vault, { "projects/demo/prd/PRD.md": "x" });

    const result = await runWithFs(
      validators["all_required_outputs_exist"]!(ctx(vault)),
    );
    expect(result.passed).toBe(true);
  });

  it("fails listing the missing paths", async () => {
    const vault = join(await makeTmp(), "brain");
    await mkdir(vault, { recursive: true });

    const result = await runWithFs(
      validators["all_required_outputs_exist"]!(ctx(vault)),
    );
    expect(result.passed).toBe(false);
    expect(result.message).toContain("projects/demo/prd/PRD.md");
  });
});

describe("validators.prd_has_required_sections", () => {
  it("passes when every required section is present", async () => {
    const vault = join(await makeTmp(), "brain");
    const sections = [
      "## Problem",
      "p",
      "## Users",
      "u",
      "## Goals",
      "g",
      "## Non-goals",
      "n",
      "## Success criteria",
      "s",
      "## Open questions",
      "o",
    ].join("\n\n");
    await seed(vault, { "projects/demo/prd/PRD.md": sections });

    const result = await runWithFs(
      validators["prd_has_required_sections"]!(ctx(vault)),
    );
    expect(result.passed).toBe(true);
  });

  it("reports the missing sections", async () => {
    const vault = join(await makeTmp(), "brain");
    await seed(vault, {
      "projects/demo/prd/PRD.md": "## Problem\n\np\n\n## Users\n\nu",
    });

    const result = await runWithFs(
      validators["prd_has_required_sections"]!(ctx(vault)),
    );
    expect(result.passed).toBe(false);
    expect(result.message).toContain("goals");
  });

  it("fails when the step has no PRD output", async () => {
    const vault = join(await makeTmp(), "brain");
    const result = await runWithFs(
      validators["prd_has_required_sections"]!(
        ctx(vault, { outputs: [{ type: "notes", path: "n.md" }] }),
      ),
    );
    expect(result.passed).toBe(false);
  });
});

describe("validators.open_questions_resolved", () => {
  const oqOutput: StepOutput = {
    type: "open_questions",
    path: "discovery/open-questions.md",
  };

  it("passes when every Q has a non-empty A on the next line", async () => {
    const vault = join(await makeTmp(), "brain");
    await seed(vault, {
      "projects/demo/discovery/open-questions.md":
        "- Q: who?\n- A: us\n- Q: when?\n- A: now",
    });
    const result = await runWithFs(
      validators["open_questions_resolved"]!(
        ctx(vault, { outputs: [oqOutput] }),
      ),
    );
    expect(result.passed).toBe(true);
  });

  it("fails when a Q has no answer", async () => {
    const vault = join(await makeTmp(), "brain");
    await seed(vault, {
      "projects/demo/discovery/open-questions.md":
        "- Q: who?\n- A:\n- Q: when?\n- A: now",
    });
    const result = await runWithFs(
      validators["open_questions_resolved"]!(
        ctx(vault, { outputs: [oqOutput] }),
      ),
    );
    expect(result.passed).toBe(false);
    expect(result.message).toContain("who?");
  });

  it("passes vacuously when the step has no open_questions output", async () => {
    const vault = join(await makeTmp(), "brain");
    const result = await runWithFs(
      validators["open_questions_resolved"]!(ctx(vault)),
    );
    expect(result.passed).toBe(true);
  });
});

describe("validators.artifact_frontmatter_valid", () => {
  it("passes when every artifact has matching frontmatter", async () => {
    const vault = join(await makeTmp(), "brain");
    await writeFrontmatterArtifact(
      vault,
      { type: "prd", path: "prd/PRD.md" },
      "body",
    );

    const result = await runWithFs(
      validators["artifact_frontmatter_valid"]!(ctx(vault)),
    );
    expect(result.passed).toBe(true);
  });

  it("fails when the artifact has no frontmatter", async () => {
    const vault = join(await makeTmp(), "brain");
    await seed(vault, { "projects/demo/prd/PRD.md": "no fence here" });
    const result = await runWithFs(
      validators["artifact_frontmatter_valid"]!(ctx(vault)),
    );
    expect(result.passed).toBe(false);
  });
});

describe("validators.run_manifest_committed", () => {
  const manifest: ContextManifest = {
    run_id: "run-1",
    project: "demo",
    step_id: "prd",
    compiled_at: "2026-05-21T00:00:00.000Z",
    included: [],
    excluded_examples: [],
    budget: {},
  };

  it("passes when the manifest was written under runs/<run-id>/", async () => {
    const vault = join(await makeTmp(), "brain");
    await Effect.runPromise(
      writeContextManifest(vault, manifest).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );
    const result = await runWithFs(
      validators["run_manifest_committed"]!(ctx(vault)),
    );
    expect(result.passed).toBe(true);
  });

  it("fails when no manifest exists", async () => {
    const vault = join(await makeTmp(), "brain");
    await mkdir(vault, { recursive: true });
    const result = await runWithFs(
      validators["run_manifest_committed"]!(ctx(vault)),
    );
    expect(result.passed).toBe(false);
  });
});

describe("runValidators", () => {
  it("runs each named validator in order", async () => {
    const vault = join(await makeTmp(), "brain");
    await mkdir(vault, { recursive: true });
    const results = await runWithFs(
      runValidators(
        ["all_required_outputs_exist", "run_manifest_committed"],
        ctx(vault),
      ),
    );
    expect(results.map((r) => r.name)).toStrictEqual([
      "all_required_outputs_exist",
      "run_manifest_committed",
    ]);
    expect(results.every((r) => !r.passed)).toBe(true);
  });

  it("surfaces unknown validator names as failures", async () => {
    const vault = join(await makeTmp(), "brain");
    const results = await runWithFs(runValidators(["nope"], ctx(vault)));
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.message).toBe("Unknown validator.");
  });
});
