import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CompiledContext,
  compileContext,
  type CompileContextOptions,
} from "./context-compiler.ts";

const makeTmp = () => mkdtemp(join(tmpdir(), "isolator-ctx-"));

const seed = async (vault: string, files: Record<string, string>) => {
  await mkdir(vault, { recursive: true });
  for (const [relPath, contents] of Object.entries(files)) {
    const absolute = join(vault, relPath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }
};

const compile = (options: CompileContextOptions): Promise<CompiledContext> =>
  Effect.runPromise(
    compileContext(options).pipe(Effect.provide(NodeContext.layer)),
  );

const baseOptions = (
  vaultPath: string,
  overrides: Partial<CompileContextOptions> = {},
): CompileContextOptions => ({
  vaultPath,
  project: "demo",
  stepId: "prd",
  runId: "run-test",
  patterns: ["projects/$slug/**", "rules/**"],
  now: () => new Date("2026-05-21T00:00:00.000Z"),
  ...overrides,
});

describe("compileContext", () => {
  it("globs the vault, substitutes $slug, and stages every file by default", async () => {
    const vault = join(await makeTmp(), "brain");
    await seed(vault, {
      "projects/demo/discovery/idea.md": "an idea",
      "projects/demo/discovery/notes.md": "notes",
      "rules/product/scope.md": "scope",
      "projects/other/discovery/idea.md": "ignored",
    });

    const { files, manifest, excluded } = await compile(baseOptions(vault));

    expect(files.map((f) => f.path).sort()).toStrictEqual([
      "projects/demo/discovery/idea.md",
      "projects/demo/discovery/notes.md",
      "rules/product/scope.md",
    ]);
    expect(excluded).toStrictEqual([]);
    expect(manifest.run_id).toBe("run-test");
    expect(manifest.project).toBe("demo");
    expect(manifest.step_id).toBe("prd");
    expect(manifest.compiled_at).toBe("2026-05-21T00:00:00.000Z");
    expect(manifest.included).toHaveLength(3);
  });

  it("records each file's source pattern as the reason", async () => {
    const vault = join(await makeTmp(), "brain");
    await seed(vault, {
      "projects/demo/discovery/idea.md": "idea",
      "rules/product/scope.md": "scope",
    });

    const { files } = await compile(baseOptions(vault));
    const idea = files.find(
      (f) => f.path === "projects/demo/discovery/idea.md",
    );
    const scope = files.find((f) => f.path === "rules/product/scope.md");

    expect(idea?.reason).toBe("projects/demo/**");
    expect(scope?.reason).toBe("rules/**");
  });

  it("returns each file's UTF-8 contents so callers do not re-read", async () => {
    const vault = join(await makeTmp(), "brain");
    await seed(vault, { "rules/r.md": "hello world" });

    const { files } = await compile(
      baseOptions(vault, { patterns: ["rules/**"] }),
    );
    expect(files).toHaveLength(1);
    expect(files[0]!.contents).toBe("hello world");
    expect(files[0]!.bytes).toBe(11);
  });

  it("drops files past maxFiles and records them as excluded", async () => {
    const vault = join(await makeTmp(), "brain");
    await seed(vault, {
      "rules/a.md": "a",
      "rules/b.md": "b",
      "rules/c.md": "c",
    });

    const { files, excluded, manifest } = await compile(
      baseOptions(vault, {
        patterns: ["rules/**"],
        policy: { maxFiles: 2 },
      }),
    );

    expect(files).toHaveLength(2);
    expect(excluded).toHaveLength(1);
    expect(manifest.excluded_examples).toHaveLength(1);
  });

  it("drops files past maxTokens", async () => {
    const vault = join(await makeTmp(), "brain");
    await seed(vault, {
      "rules/a.md": "x".repeat(40),
      "rules/b.md": "x".repeat(40),
    });

    const { files, excluded } = await compile(
      baseOptions(vault, {
        patterns: ["rules/**"],
        policy: { maxTokens: 10 },
      }),
    );

    expect(files).toHaveLength(1);
    expect(excluded).toStrictEqual(["rules/b.md"]);
  });

  it("returns an empty manifest when no patterns match", async () => {
    const vault = join(await makeTmp(), "brain");
    await mkdir(vault, { recursive: true });

    const { files, manifest } = await compile(
      baseOptions(vault, { patterns: ["rules/**"] }),
    );

    expect(files).toStrictEqual([]);
    expect(manifest.included).toStrictEqual([]);
  });
});
