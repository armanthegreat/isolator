import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scaffoldVault, VAULT_DIRS } from "./vault.ts";

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

  it("adds a .gitkeep to each directory that ships empty", async () => {
    const dir = join(await makeTmp(), "brain");
    await run(dir);

    for (const subdir of ["skills", "roles", "rules", "projects"]) {
      expect(await readFile(join(dir, subdir, ".gitkeep"), "utf8")).toBe("");
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
