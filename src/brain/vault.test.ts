import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  expandSlug,
  expandSlugs,
  globVault,
  readNote,
  scaffoldVault,
  VAULT_DIRS,
} from "./vault.ts";

const makeTmp = () => mkdtemp(join(tmpdir(), "isolator-vault-"));

const run = (dir: string) =>
  Effect.runPromise(scaffoldVault(dir).pipe(Effect.provide(NodeContext.layer)));

/** Run `scaffoldVault` expecting failure; resolves to the typed error. */
const runError = (dir: string) =>
  Effect.runPromise(
    scaffoldVault(dir).pipe(Effect.provide(NodeContext.layer), Effect.flip),
  );

const isDir = async (path: string) => (await stat(path)).isDirectory();

describe("scaffoldVault", () => {
  it("creates the full vault directory tree", async () => {
    const dir = join(await makeTmp(), "brain");
    await run(dir);

    for (const subdir of VAULT_DIRS) {
      expect(await isDir(join(dir, subdir))).toBe(true);
    }
  });

  it("writes a non-empty base system prompt", async () => {
    const dir = join(await makeTmp(), "brain");
    await run(dir);

    const base = await readFile(join(dir, "system", "base.md"), "utf8");
    expect(base).toContain("# Base system prompt");
    expect(base).toContain("Operating principles");
  });

  it("creates an empty runs.jsonl telemetry log", async () => {
    const dir = join(await makeTmp(), "brain");
    await run(dir);

    expect(await readFile(join(dir, "system", "runs.jsonl"), "utf8")).toBe("");
  });

  it("adds a .gitkeep to each empty directory without a template README", async () => {
    const dir = join(await makeTmp(), "brain");
    await run(dir);

    expect(await readFile(join(dir, "projects", ".gitkeep"), "utf8")).toBe("");
  });

  it("seeds a template README into skills, roles, and rules", async () => {
    const dir = join(await makeTmp(), "brain");
    await run(dir);

    for (const subdir of ["skills", "roles", "rules"]) {
      const readme = await readFile(join(dir, subdir, "README.md"), "utf8");
      expect(readme.length).toBeGreaterThan(0);
      expect(readme).toContain(
        `# ${subdir[0]!.toUpperCase()}${subdir.slice(1)}`,
      );
    }
  });

  it("creates missing parent directories", async () => {
    const dir = join(await makeTmp(), "deeply", "nested", "brain");
    const created = await run(dir);

    expect(created).toBe(resolve(dir));
    expect(await isDir(join(dir, "system"))).toBe(true);
  });

  it("returns the resolved absolute vault path", async () => {
    const dir = join(await makeTmp(), "brain", "..", "brain");
    expect(await run(dir)).toBe(resolve(dir));
  });

  it("refuses to scaffold over an already-initialized vault", async () => {
    const dir = join(await makeTmp(), "brain");
    await run(dir);

    const error = await runError(dir);
    expect(error._tag).toBe("VaultExistsError");
    expect(error.path).toBe(resolve(dir));
  });
});

const seed = async (vault: string, files: Record<string, string>) => {
  await mkdir(vault, { recursive: true });
  for (const [relPath, contents] of Object.entries(files)) {
    const absolute = join(vault, relPath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }
};

describe("expandSlug / expandSlugs", () => {
  it("substitutes every $slug occurrence", () => {
    expect(expandSlug("projects/$slug/$slug.md", "demo")).toBe(
      "projects/demo/demo.md",
    );
  });

  it("returns the pattern unchanged when no $slug appears", () => {
    expect(expandSlug("rules/product/*", "demo")).toBe("rules/product/*");
  });

  it("expands an array of patterns in order", () => {
    expect(expandSlugs(["a/$slug.md", "b/$slug/**"], "demo")).toStrictEqual([
      "a/demo.md",
      "b/demo/**",
    ]);
  });
});

describe("readNote", () => {
  it("reads a vault note as UTF-8 text", async () => {
    const vault = join(await makeTmp(), "brain");
    await seed(vault, { "system/base.md": "# base" });

    const text = await Effect.runPromise(
      readNote(vault, "system/base.md").pipe(Effect.provide(NodeContext.layer)),
    );

    expect(text).toBe("# base");
  });

  it("fails with VaultReadError when the file is missing", async () => {
    const vault = join(await makeTmp(), "brain");
    await mkdir(vault, { recursive: true });

    const error = await Effect.runPromise(
      readNote(vault, "system/missing.md").pipe(
        Effect.provide(NodeContext.layer),
        Effect.flip,
      ),
    );

    expect(error._tag).toBe("VaultReadError");
    expect(error.path).toBe(join(vault, "system/missing.md"));
  });
});

describe("globVault", () => {
  it("returns vault-relative matches with their source pattern", async () => {
    const vault = join(await makeTmp(), "brain");
    await seed(vault, {
      "skills/prd/SKILL.md": "skill",
      "skills/prd/notes.md": "notes",
      "rules/product/scope.md": "scope",
    });

    const matches = await Effect.runPromise(
      globVault(vault, ["skills/prd/**", "rules/product/*"]),
    );

    expect(matches.map((m) => m.path).sort()).toStrictEqual([
      "rules/product/scope.md",
      "skills/prd/SKILL.md",
      "skills/prd/notes.md",
    ]);
    const skill = matches.find((m) => m.path === "skills/prd/SKILL.md");
    expect(skill?.reason).toBe("skills/prd/**");
  });

  it("substitutes $slug when the option is given", async () => {
    const vault = join(await makeTmp(), "brain");
    await seed(vault, {
      "projects/demo/discovery/idea.md": "idea",
      "projects/other/discovery/idea.md": "other-idea",
    });

    const matches = await Effect.runPromise(
      globVault(vault, ["projects/$slug/discovery/**"], { slug: "demo" }),
    );

    expect(matches.map((m) => m.path)).toStrictEqual([
      "projects/demo/discovery/idea.md",
    ]);
  });

  it("records the first matching pattern as the reason for a duplicate", async () => {
    const vault = join(await makeTmp(), "brain");
    await seed(vault, { "skills/prd/SKILL.md": "skill" });

    const matches = await Effect.runPromise(
      globVault(vault, ["skills/prd/SKILL.md", "skills/**"]),
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]!.reason).toBe("skills/prd/SKILL.md");
  });

  it("returns an empty array when nothing matches", async () => {
    const vault = join(await makeTmp(), "brain");
    await mkdir(vault, { recursive: true });

    const matches = await Effect.runPromise(globVault(vault, ["skills/**"]));

    expect(matches).toStrictEqual([]);
  });
});
