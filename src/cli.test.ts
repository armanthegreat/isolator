import { exec } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

const commitFile = async (
  dir: string,
  name: string,
  content: string,
  message: string,
) => {
  await writeFile(join(dir, name), content);
  await execAsync(`git add "${name}"`, { cwd: dir });
  await execAsync(`git commit -m "${message}"`, { cwd: dir });
};

const cliPath = join(import.meta.dirname, "main.ts");

const runCli = (args: string, cwd: string) =>
  execAsync(`node ${cliPath} ${args}`, { cwd });

describe("isolator CLI", () => {
  it("shows help with --help flag", async () => {
    const { stdout } = await runCli("--help", process.cwd());
    expect(stdout).toContain("isolator");
    // Brain verbs are the canonical surface.
    expect(stdout).toContain("brain");
    expect(stdout).toContain("connect");
    expect(stdout).toContain("pipeline");
    // Per-project image utilities stay.
    expect(stdout).toContain("docker");
    expect(stdout).toContain("podman");
    expect(stdout).toContain("docker build-image");
    expect(stdout).toContain("docker remove-image");
    // The retired per-project orchestration verbs must not reappear.
    expect(stdout).not.toContain(" init ");
    expect(stdout).not.toContain(" run ");
    expect(stdout).not.toContain("interactive");
    expect(stdout).not.toContain("setup-sandbox");
    expect(stdout).not.toContain("cleanup-sandbox");
    expect(stdout).not.toContain("sync-in");
    expect(stdout).not.toContain("sync-out");
  });

  it("--help shows podman namespace", async () => {
    const { stdout } = await runCli("--help", process.cwd());
    expect(stdout).toContain("podman");
    expect(stdout).toContain("podman build-image");
    expect(stdout).toContain("podman remove-image");
  });

  it("docker --help shows build-image and remove-image subcommands", async () => {
    const { stdout } = await runCli("docker --help", process.cwd());
    expect(stdout).toContain("build-image");
    expect(stdout).toContain("remove-image");
  });

  it("podman --help shows build-image and remove-image subcommands", async () => {
    const { stdout } = await runCli("podman --help", process.cwd());
    expect(stdout).toContain("build-image");
    expect(stdout).toContain("remove-image");
  });

  it("podman build-image --help shows --containerfile and --image-name flags", async () => {
    const { stdout } = await runCli("podman build-image --help", process.cwd());
    expect(stdout).toContain("--containerfile");
    expect(stdout).toContain("--image-name");
  });

  it("docker build-image errors when .isolator/ is missing", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    try {
      await runCli("docker build-image", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("No .isolator/ found");
    }
  });

  it("podman build-image errors when .isolator/ is missing", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    try {
      await runCli("podman build-image", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("No .isolator/ found");
    }
  });

  it("old top-level build-image command no longer works", async () => {
    try {
      await runCli("build-image", process.cwd());
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      expect(err).toBeDefined();
    }
  });

  it("old top-level remove-image command no longer works", async () => {
    try {
      await runCli("remove-image", process.cwd());
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      expect(err).toBeDefined();
    }
  });

  it("retired `init` verb is gone", async () => {
    try {
      await runCli("init --help", process.cwd());
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      expect(err).toBeDefined();
    }
  });

  it("connect --help exposes the new selector flags", async () => {
    const { stdout } = await runCli("connect --help", process.cwd());
    expect(stdout).toContain("--agent");
    expect(stdout).toContain("--sandbox");
    expect(stdout).toContain("--model");
    expect(stdout).toContain("--backlog-manager");
    expect(stdout).toContain("--pipeline");
  });

  it("connect --agent nonexistent produces error listing available agents", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));

    try {
      await runCli("connect demo --agent nonexistent", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("nonexistent");
      expect(output).toContain("claude-code");
    }
  });

  it("--help shows the pipeline command", async () => {
    const { stdout } = await runCli("--help", process.cwd());
    expect(stdout).toContain("pipeline");
  });

  it("pipeline with an unknown name lists the available pipelines", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));

    try {
      await runCli("pipeline nonexistent demo", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("nonexistent");
      expect(output).toContain("echo");
    }
  });
});
