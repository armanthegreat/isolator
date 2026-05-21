import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveEnv } from "./EnvResolver.ts";

const makeEnvFile = async (content: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "env-resolver-"));
  const path = join(dir, ".env");
  await writeFile(path, content);
  return path;
};

const runResolveEnv = (envPath: string) =>
  Effect.runPromise(
    resolveEnv(envPath).pipe(Effect.provide(NodeContext.layer)),
  );

describe("resolveEnv", () => {
  it("returns all key-value pairs from the central env file", async () => {
    const path = await makeEnvFile(
      "ANTHROPIC_API_KEY=sc-key\nGH_TOKEN=sc-gh\n",
    );
    const env = await runResolveEnv(path);
    expect(env).toEqual({
      ANTHROPIC_API_KEY: "sc-key",
      GH_TOKEN: "sc-gh",
    });
  });

  it("returns empty object when the env file does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "env-resolver-"));
    const env = await runResolveEnv(join(dir, "missing.env"));
    expect(env).toEqual({});
  });

  it("falls back to process.env for declared keys with empty values", async () => {
    const path = await makeEnvFile("MY_TOKEN=\n");

    const orig = process.env["MY_TOKEN"];
    try {
      process.env["MY_TOKEN"] = "from-process";
      const env = await runResolveEnv(path);
      expect(env["MY_TOKEN"]).toBe("from-process");
    } finally {
      if (orig === undefined) delete process.env["MY_TOKEN"];
      else process.env["MY_TOKEN"] = orig;
    }
  });

  it("does NOT pull keys from process.env that are not declared", async () => {
    const path = await makeEnvFile("DECLARED_KEY=value\n");
    const env = await runResolveEnv(path);
    expect(env["PATH"]).toBeUndefined();
    expect(env["HOME"]).toBeUndefined();
    expect(env["DECLARED_KEY"]).toBe("value");
  });

  it("the env file value takes precedence over process.env", async () => {
    const path = await makeEnvFile("MY_VAR=file-val\n");

    const orig = process.env["MY_VAR"];
    try {
      process.env["MY_VAR"] = "from-process";
      const env = await runResolveEnv(path);
      expect(env["MY_VAR"]).toBe("file-val");
    } finally {
      if (orig === undefined) delete process.env["MY_VAR"];
      else process.env["MY_VAR"] = orig;
    }
  });

  it("ignores comments and blank lines", async () => {
    const path = await makeEnvFile(
      "# This is a comment\n\nKEY1=val1\n\n# Another comment\nKEY2=val2\n",
    );
    const env = await runResolveEnv(path);
    expect(env).toEqual({ KEY1: "val1", KEY2: "val2" });
  });

  it("does no validation — returns whatever keys are present", async () => {
    const path = await makeEnvFile(
      "NPM_TOKEN=npm123\nDATABASE_URL=pg://localhost\n",
    );
    const env = await runResolveEnv(path);
    expect(env).toEqual({
      NPM_TOKEN: "npm123",
      DATABASE_URL: "pg://localhost",
    });
  });

  it("strips matching double quotes from values", async () => {
    const path = await makeEnvFile(
      'ANTHROPIC_API_KEY="sk-ant-api03-real-key"\n',
    );
    const env = await runResolveEnv(path);
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-ant-api03-real-key");
  });

  it("strips matching single quotes from values", async () => {
    const path = await makeEnvFile("TOKEN='my-token'\n");
    const env = await runResolveEnv(path);
    expect(env["TOKEN"]).toBe("my-token");
  });

  it("leaves mismatched quotes as-is", async () => {
    const path = await makeEnvFile(`KEY="value'\n`);
    const env = await runResolveEnv(path);
    expect(env["KEY"]).toBe(`"value'`);
  });

  it("leaves interior quotes as-is", async () => {
    const path = await makeEnvFile('KEY=some"thing\n');
    const env = await runResolveEnv(path);
    expect(env["KEY"]).toBe('some"thing');
  });

  it("handles empty quoted values", async () => {
    const path = await makeEnvFile('KEY=""\n');
    const env = await runResolveEnv(path);
    expect(env).toEqual({});
  });

  it("unescapes \\n in double-quoted values", async () => {
    const path = await makeEnvFile('KEY="line1\\nline2"\n');
    const env = await runResolveEnv(path);
    expect(env["KEY"]).toBe("line1\nline2");
  });

  it("does not unescape \\n in single-quoted values", async () => {
    const path = await makeEnvFile("KEY='line1\\nline2'\n");
    const env = await runResolveEnv(path);
    expect(env["KEY"]).toBe("line1\\nline2");
  });

  it("preserves internal whitespace in double-quoted values", async () => {
    const path = await makeEnvFile('KEY="  spaced  "\n');
    const env = await runResolveEnv(path);
    expect(env["KEY"]).toBe("  spaced  ");
  });

  it("unescapes \\r, \\t, and \\\\ in double-quoted values", async () => {
    const path = await makeEnvFile('TAB="a\\tb"\nCR="a\\rb"\nBS="a\\\\b"\n');
    const env = await runResolveEnv(path);
    expect(env["TAB"]).toBe("a\tb");
    expect(env["CR"]).toBe("a\rb");
    expect(env["BS"]).toBe("a\\b");
  });

  it("handles escaped backslash before n in double-quoted values", async () => {
    const path = await makeEnvFile('KEY="a\\\\nb"\n');
    const env = await runResolveEnv(path);
    expect(env["KEY"]).toBe("a\\nb");
  });

  it("parses unquoted values unchanged", async () => {
    const path = await makeEnvFile("KEY=plain\n");
    const env = await runResolveEnv(path);
    expect(env["KEY"]).toBe("plain");
  });
});
