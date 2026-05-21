import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import {
  __testing__,
  readArtifactFrontmatter,
  writeArtifact,
  type WriteArtifactOptions,
  writeContextManifest,
} from "./artifacts.ts";
import type { ContextManifest } from "./schemas.ts";

const makeTmp = () => mkdtemp(join(tmpdir(), "isolator-artifacts-"));

const seed = async (vault: string, files: Record<string, string>) => {
  await mkdir(vault, { recursive: true });
  for (const [relPath, contents] of Object.entries(files)) {
    const absolute = join(vault, relPath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }
};

const baseOptions = (
  vault: string,
  overrides: Partial<WriteArtifactOptions> = {},
): WriteArtifactOptions => ({
  vaultPath: vault,
  project: "demo",
  stepId: "prd",
  runId: "run-1",
  output: { type: "prd", path: "prd/PRD.md" },
  body: "# PRD body",
  ...overrides,
});

const write = (options: WriteArtifactOptions) =>
  Effect.runPromise(
    writeArtifact(options).pipe(Effect.provide(NodeContext.layer)),
  );

const readFm = (absPath: string) =>
  Effect.runPromise(
    readArtifactFrontmatter(absPath).pipe(Effect.provide(NodeContext.layer)),
  );

const splitFrontmatter = (text: string) => {
  const parsed = __testing__.parseFrontmatter(text);
  if (parsed === undefined) throw new Error("expected frontmatter");
  return parsed;
};

describe("writeArtifact", () => {
  it("writes a new artifact with version 1 and the expected frontmatter", async () => {
    const vault = join(await makeTmp(), "brain");
    const result = await write(baseOptions(vault));

    expect(result.relPath).toBe("projects/demo/prd/PRD.md");
    expect(result.frontmatter.version).toBe(1);
    expect(result.frontmatter.artifact_id).toBe("demo/prd/prd-prd");
    expect(result.frontmatter.status).toBe("draft");

    const text = await readFile(result.absPath, "utf8");
    const { frontmatter, body } = splitFrontmatter(text);
    expect(frontmatter["produced_by"]).toBe("prd");
    expect(frontmatter["produced_in_run"]).toBe("run-1");
    expect(body).toBe("# PRD body\n");
  });

  it("bumps the version when an artifact already exists", async () => {
    const vault = join(await makeTmp(), "brain");
    await write(baseOptions(vault, { runId: "run-1" }));
    const second = await write(baseOptions(vault, { runId: "run-2" }));

    expect(second.frontmatter.version).toBe(2);
    expect(second.frontmatter.produced_in_run).toBe("run-2");
  });

  it("treats a pre-existing artifact without frontmatter as version 0", async () => {
    const vault = join(await makeTmp(), "brain");
    await seed(vault, { "projects/demo/prd/PRD.md": "legacy text" });

    const result = await write(baseOptions(vault));
    expect(result.frontmatter.version).toBe(1);
  });

  it("honors approval_required and status overrides", async () => {
    const vault = join(await makeTmp(), "brain");
    const result = await write(
      baseOptions(vault, { approvalRequired: true, status: "approved" }),
    );

    expect(result.frontmatter.approval_required).toBe(true);
    expect(result.frontmatter.status).toBe("approved");
  });
});

describe("writeContextManifest", () => {
  it("writes the manifest under projects/<slug>/runs/<run-id>/", async () => {
    const vault = join(await makeTmp(), "brain");
    const manifest: ContextManifest = {
      run_id: "run-1",
      project: "demo",
      step_id: "prd",
      compiled_at: "2026-05-21T00:00:00.000Z",
      included: [{ path: "rules/r.md", reason: "rules/**", bytes: 5 }],
      excluded_examples: [],
      budget: { maxFiles: 10 },
    };

    const relPath = await Effect.runPromise(
      writeContextManifest(vault, manifest).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    expect(relPath).toBe("projects/demo/runs/run-1/context-manifest.yml");
    const written = await readFile(join(vault, relPath), "utf8");
    const decoded = parseYaml(written);
    expect(decoded.project).toBe("demo");
    expect(decoded.included).toHaveLength(1);
  });
});

describe("readArtifactFrontmatter", () => {
  it("reads back a written artifact's frontmatter", async () => {
    const vault = join(await makeTmp(), "brain");
    const result = await write(baseOptions(vault));

    const fm = await readFm(result.absPath);
    expect(fm?.artifact_id).toBe("demo/prd/prd-prd");
    expect(fm?.version).toBe(1);
  });

  it("returns undefined for a missing file", async () => {
    const fm = await readFm("/tmp/definitely-not-a-real-file-xyz.md");
    expect(fm).toBeUndefined();
  });

  it("returns undefined for a file without frontmatter", async () => {
    const vault = join(await makeTmp(), "brain");
    await seed(vault, { "notes.md": "no fence here" });
    const fm = await readFm(join(vault, "notes.md"));
    expect(fm).toBeUndefined();
  });
});
