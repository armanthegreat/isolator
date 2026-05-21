import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRepo, linkRepo } from "./repo.ts";

const makeTmp = () => mkdtemp(join(tmpdir(), "isolator-repo-"));

const create = (dir: string) =>
  Effect.runPromise(createRepo(dir).pipe(Effect.provide(NodeContext.layer)));

const createError = (dir: string) =>
  Effect.runPromise(
    createRepo(dir).pipe(Effect.provide(NodeContext.layer), Effect.flip),
  );

const link = (dir: string) =>
  Effect.runPromise(linkRepo(dir).pipe(Effect.provide(NodeContext.layer)));

const linkError = (dir: string) =>
  Effect.runPromise(
    linkRepo(dir).pipe(Effect.provide(NodeContext.layer), Effect.flip),
  );

const exists = async (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe("createRepo", () => {
  it("initializes a git repo with a README and design/ folder", async () => {
    const dir = join(await makeTmp(), "acme");
    const repo = await create(dir);

    expect(repo.path).toBe(dir);
    expect(await exists(join(dir, ".git"))).toBe(true);
    expect(await readFile(join(dir, "README.md"), "utf8")).toContain("# acme");
    expect(await exists(join(dir, "design", ".gitkeep"))).toBe(true);
  });

  it("reports no remote URL for a fresh repo", async () => {
    const repo = await create(join(await makeTmp(), "acme"));
    expect(repo.repoUrl).toBeUndefined();
  });

  it("refuses to create a repo in a non-empty directory", async () => {
    const dir = await makeTmp();
    await writeFile(join(dir, "existing.txt"), "x");

    const error = await createError(dir);
    expect(error._tag).toBe("RepoError");
  });
});

describe("linkRepo", () => {
  it("links an existing directory", async () => {
    const dir = await create(join(await makeTmp(), "acme"));

    const repo = await link(dir.path);
    expect(repo.path).toBe(dir.path);
    expect(repo.repoUrl).toBeUndefined();
  });

  it("fails with RepoError when the path does not exist", async () => {
    const error = await linkError(join(await makeTmp(), "missing"));
    expect(error._tag).toBe("RepoError");
  });
});
