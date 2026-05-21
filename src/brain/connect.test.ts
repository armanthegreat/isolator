import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IsolatorHome, isolatorHomeLayer, loadConfig } from "./config.ts";
import { connectProject, createBrain } from "./connect.ts";

const makeTmp = () => mkdtemp(join(tmpdir(), "isolator-connect-"));

const run = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | IsolatorHome>,
  homeDir: string,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(NodeContext.layer),
      Effect.provide(isolatorHomeLayer(homeDir)),
    ),
  );

/** Run an effect expecting failure; resolves to the typed error. */
const runError = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | IsolatorHome>,
  homeDir: string,
) => run(effect.pipe(Effect.flip), homeDir);

const exists = async (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe("createBrain", () => {
  it("scaffolds a vault and records it as the configured brain", async () => {
    const home = await makeTmp();
    const vaultPath = await run(
      createBrain(join(await makeTmp(), "brain")),
      home,
    );

    expect(await exists(join(vaultPath, "system", "base.md"))).toBe(true);
    expect((await run(loadConfig, home)).vault_path).toBe(vaultPath);
  });
});

describe("connectProject", () => {
  it("creates a brain, repo, vault folder, and config entry in one go", async () => {
    const home = await makeTmp();
    const root = await makeTmp();

    const result = await run(
      connectProject({
        name: "Acme Corp",
        cwd: root,
        newBrain: join(root, "brain"),
        newRepo: join(root, "code"),
      }),
      home,
    );

    expect(result.slug).toBe("acme-corp");
    expect(result.createdBrain).toBe(true);
    expect(await exists(join(result.projectDir, "overview.md"))).toBe(true);
    expect(await exists(join(result.repoPath, ".git"))).toBe(true);

    const config = await run(loadConfig, home);
    expect(config.vault_path).toBe(result.vaultPath);
    expect(config.projects["acme-corp"]).toEqual({
      repo_path: result.repoPath,
    });
  });

  it("defaults the source repo to ./<slug> when no repo flag is given", async () => {
    const home = await makeTmp();
    const root = await makeTmp();
    await run(createBrain(join(root, "brain")), home);

    const result = await run(connectProject({ name: "acme", cwd: root }), home);

    expect(result.repoPath).toBe(join(root, "acme"));
    expect(await exists(join(root, "acme", ".git"))).toBe(true);
  });

  it("fails with BrainNotFoundError when no brain is configured", async () => {
    const home = await makeTmp();
    const root = await makeTmp();

    const error = await runError(
      connectProject({ name: "acme", cwd: root }),
      home,
    );
    expect(error._tag).toBe("BrainNotFoundError");
  });

  it("fails with InvalidSlugError when the name yields an empty slug", async () => {
    const home = await makeTmp();
    const root = await makeTmp();
    await run(createBrain(join(root, "brain")), home);

    const error = await runError(
      connectProject({ name: "!!!", cwd: root }),
      home,
    );
    expect(error._tag).toBe("InvalidSlugError");
  });
});
