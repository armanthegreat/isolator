import { describe, expect, it } from "vitest";
import {
  getAgent,
  getBacklogManager,
  getSandboxProvider,
  listAgents,
  listBacklogManagers,
  listSandboxProviders,
  renderDockerfile,
} from "./selectors.ts";

describe("agent registry", () => {
  it("lists claude-code, pi, codex, opencode", () => {
    const names = listAgents().map((a) => a.name);
    expect(names).toEqual(["claude-code", "pi", "codex", "opencode"]);
  });

  it("getAgent resolves a known id and rejects an unknown one", () => {
    expect(getAgent("claude-code")?.label).toBe("Claude Code");
    expect(getAgent("nonexistent")).toBeUndefined();
  });

  it("every agent carries a Dockerfile template and a default model", () => {
    for (const agent of listAgents()) {
      expect(agent.defaultModel.length).toBeGreaterThan(0);
      expect(agent.dockerfileTemplate).toContain("{{BACKLOG_MANAGER_TOOLS}}");
    }
  });
});

describe("sandbox provider registry", () => {
  it("lists docker and podman with their containerfile names", () => {
    expect(getSandboxProvider("docker")?.containerfileName).toBe("Dockerfile");
    expect(getSandboxProvider("podman")?.containerfileName).toBe(
      "Containerfile",
    );
  });

  it("getSandboxProvider rejects an unknown id", () => {
    expect(getSandboxProvider("nonexistent")).toBeUndefined();
    expect(listSandboxProviders()).toHaveLength(2);
  });
});

describe("backlog manager registry", () => {
  it("lists github-issues and beads", () => {
    const names = listBacklogManagers().map((b) => b.name);
    expect(names).toEqual(["github-issues", "beads"]);
  });

  it("github-issues declares list/view/close commands", () => {
    const gh = getBacklogManager("github-issues");
    expect(gh?.commands.listTasks).toContain("gh issue list");
    expect(gh?.commands.viewTask).toContain("<ID>");
    expect(gh?.commands.closeTask).toContain("<ID>");
  });

  it("getBacklogManager rejects an unknown id", () => {
    expect(getBacklogManager("nonexistent")).toBeUndefined();
  });
});

describe("renderDockerfile", () => {
  it("substitutes the backlog manager's tool snippet into the agent template", () => {
    const agent = getAgent("claude-code")!;
    const backlog = getBacklogManager("github-issues")!;
    const rendered = renderDockerfile(agent, backlog);

    expect(rendered).not.toContain("{{BACKLOG_MANAGER_TOOLS}}");
    expect(rendered).toContain("Install GitHub CLI");
    expect(rendered).toContain("Install Claude Code CLI");
  });

  it("substitutes the beads tool snippet", () => {
    const agent = getAgent("claude-code")!;
    const beads = getBacklogManager("beads")!;
    const rendered = renderDockerfile(agent, beads);

    expect(rendered).not.toContain("{{BACKLOG_MANAGER_TOOLS}}");
    expect(rendered).toContain("Install system dependencies for Beads");
  });
});
