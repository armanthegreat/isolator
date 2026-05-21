import { NodeContext } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  registerProject,
  scaffoldProject,
  type ScaffoldProjectOptions,
  toProjectSlug,
} from "./projects.ts";
import { type IsolatorConfig, ProjectOverview } from "./schemas.ts";

const makeVault = () => mkdtemp(join(tmpdir(), "isolator-vault-"));

const scaffold = (options: ScaffoldProjectOptions) =>
  Effect.runPromise(
    scaffoldProject(options).pipe(Effect.provide(NodeContext.layer)),
  );

/** Run `scaffoldProject` expecting failure; resolves to the typed error. */
const scaffoldError = (options: ScaffoldProjectOptions) =>
  Effect.runPromise(
    scaffoldProject(options).pipe(
      Effect.provide(NodeContext.layer),
      Effect.flip,
    ),
  );

/** Read and decode the YAML frontmatter block of a Markdown file. */
const readFrontmatter = async (path: string) => {
  const content = await readFile(path, "utf8");
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error(`no frontmatter in ${path}`);
  return Schema.decodeUnknownSync(ProjectOverview)(parseYaml(match[1]!));
};

describe("toProjectSlug", () => {
  it("lowercases and hyphenates a human name", () => {
    expect(toProjectSlug("Acme Corp")).toBe("acme-corp");
  });

  it("collapses non-alphanumeric runs and trims edge hyphens", () => {
    expect(toProjectSlug("  Hello_World!! ")).toBe("hello-world");
  });

  it("returns an empty string when nothing usable remains", () => {
    expect(toProjectSlug("!!!")).toBe("");
  });
});

describe("scaffoldProject", () => {
  it("creates overview.md and a discovery/idea.md stub", async () => {
    const vaultPath = await makeVault();
    const dir = await scaffold({ vaultPath, slug: "acme" });

    expect(dir).toBe(join(vaultPath, "projects", "acme"));
    const idea = await readFile(join(dir, "discovery", "idea.md"), "utf8");
    expect(idea).toContain("# Idea");
  });

  it("writes valid overview frontmatter including repo_url", async () => {
    const vaultPath = await makeVault();
    const dir = await scaffold({
      vaultPath,
      slug: "acme",
      repoUrl: "git@github.com:armanthegreat/acme.git",
    });

    const frontmatter = await readFrontmatter(join(dir, "overview.md"));
    expect(frontmatter).toEqual({
      project: "acme",
      status: "active",
      repo_url: "git@github.com:armanthegreat/acme.git",
    });
  });

  it("omits repo_url from frontmatter when no remote is given", async () => {
    const vaultPath = await makeVault();
    const dir = await scaffold({ vaultPath, slug: "acme" });

    const frontmatter = await readFrontmatter(join(dir, "overview.md"));
    expect(frontmatter).toEqual({ project: "acme", status: "active" });
  });

  it("fails with InvalidSlugError on a malformed slug", async () => {
    const vaultPath = await makeVault();

    const error = await scaffoldError({ vaultPath, slug: "Acme Corp" });
    expect(error._tag).toBe("InvalidSlugError");
  });

  it("fails with ProjectExistsError when the folder already exists", async () => {
    const vaultPath = await makeVault();
    await scaffold({ vaultPath, slug: "acme" });

    const error = await scaffoldError({ vaultPath, slug: "acme" });
    expect(error._tag).toBe("ProjectExistsError");
  });
});

describe("registerProject", () => {
  const base: IsolatorConfig = {
    vault_path: "/home/me/brain",
    defaults: {},
    projects: { existing: { repo_path: "/code/existing" } },
  };

  it("adds a project entry while preserving existing ones", () => {
    const next = registerProject(base, "acme", "/code/acme");

    expect(next.projects).toEqual({
      existing: { repo_path: "/code/existing" },
      acme: { repo_path: "/code/acme" },
    });
    expect(base.projects).toEqual({
      existing: { repo_path: "/code/existing" },
    });
  });

  it("re-points an already-registered slug", () => {
    const next = registerProject(base, "existing", "/code/moved");

    expect(next.projects.existing).toEqual({ repo_path: "/code/moved" });
  });
});
