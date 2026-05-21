import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatorHomeLayer, loadConfig } from "./config.ts";

const makeHome = () => mkdtemp(join(tmpdir(), "isolator-home-"));

const resolved = (dir: string) =>
  loadConfig.pipe(
    Effect.provide(isolatorHomeLayer(dir)),
    Effect.provide(NodeContext.layer),
  );

/** Run `loadConfig` expecting success. */
const load = (dir: string) => Effect.runPromise(resolved(dir));

/** Run `loadConfig` expecting failure; resolves to the typed error. */
const loadError = (dir: string) =>
  Effect.runPromise(resolved(dir).pipe(Effect.flip));

describe("loadConfig", () => {
  it("loads and validates a complete config.yml", async () => {
    const dir = await makeHome();
    await writeFile(
      join(dir, "config.yml"),
      [
        "vault_path: /home/me/brain",
        "defaults:",
        "  agent: claude-code",
        "  model: claude-opus-4-7",
        "projects:",
        "  acme:",
        "    repo_path: /home/me/code/acme",
        "",
      ].join("\n"),
    );

    const config = await load(dir);
    expect(config.vault_path).toBe("/home/me/brain");
    expect(config.defaults).toEqual({
      agent: "claude-code",
      model: "claude-opus-4-7",
    });
    expect(config.projects).toEqual({
      acme: { repo_path: "/home/me/code/acme" },
    });
  });

  it("defaults `defaults` and `projects` to {} when omitted", async () => {
    const dir = await makeHome();
    await writeFile(join(dir, "config.yml"), "vault_path: /home/me/brain\n");

    const config = await load(dir);
    expect(config.defaults).toEqual({});
    expect(config.projects).toEqual({});
  });

  it("fails with ConfigNotFoundError when config.yml is absent", async () => {
    const dir = await makeHome();

    const error = await loadError(dir);
    expect(error._tag).toBe("ConfigNotFoundError");
    expect(error.path).toBe(join(dir, "config.yml"));
  });

  it("fails with ConfigInvalidError on malformed YAML", async () => {
    const dir = await makeHome();
    await writeFile(join(dir, "config.yml"), "vault_path: [unclosed\n");

    const error = await loadError(dir);
    expect(error._tag).toBe("ConfigInvalidError");
  });

  it("fails with ConfigInvalidError when a required field is missing", async () => {
    const dir = await makeHome();
    await writeFile(join(dir, "config.yml"), "defaults:\n  model: x\n");

    const error = await loadError(dir);
    expect(error._tag).toBe("ConfigInvalidError");
  });

  it("rejects an empty vault_path", async () => {
    const dir = await makeHome();
    await writeFile(join(dir, "config.yml"), 'vault_path: ""\n');

    const error = await loadError(dir);
    expect(error._tag).toBe("ConfigInvalidError");
  });

  it("rejects a project entry missing repo_path", async () => {
    const dir = await makeHome();
    await writeFile(
      join(dir, "config.yml"),
      "vault_path: /home/me/brain\nprojects:\n  acme: {}\n",
    );

    const error = await loadError(dir);
    expect(error._tag).toBe("ConfigInvalidError");
  });
});
