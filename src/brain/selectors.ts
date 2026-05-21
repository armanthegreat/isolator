/**
 * Selectors — registries of the choices the brain offers a connecting project:
 * which agent, which sandbox provider, which backlog manager.
 *
 * These were previously embedded in the (now-removed) `isolator init` flow.
 * They live here so `isolator connect`'s interactive UX (and any future
 * non-interactive flag-driven path) can pick from a single source of truth.
 *
 * This module is intentionally registry + Dockerfile-template only. Project
 * scaffolding (writing `<project-repo>/.isolator/Dockerfile`) lives in
 * `repo.ts` so the brain's I/O surface stays cohesive.
 */

import { SANDBOX_REPO_DIR } from "../SandboxFactory.ts";

// ---------------------------------------------------------------------------
// Agent registry
// ---------------------------------------------------------------------------

export interface AgentEntry {
  readonly name: string;
  readonly label: string;
  readonly defaultModel: string;
  readonly factoryImport: string;
  readonly dockerfileTemplate: string;
  /** Lines to include in the central `~/.isolator/.env.example` for this agent. */
  readonly envExample: string;
}

const CLAUDE_CODE_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{BACKLOG_MANAGER_TOOLS}}

# Build-args for UID/GID alignment: isolator docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -g $AGENT_GID node && usermod -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER \${AGENT_UID}:\${AGENT_GID}

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# Add Claude to PATH
ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

# In worktree sandbox mode, Isolator bind-mounts the git worktree at ${SANDBOX_REPO_DIR}
# and overrides the working directory to ${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that ${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const PI_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{BACKLOG_MANAGER_TOOLS}}

# Build-args for UID/GID alignment: isolator docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -g $AGENT_GID node && usermod -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

# Install pi coding agent (run as root before USER agent)
RUN npm install -g @mariozechner/pi-coding-agent

USER \${AGENT_UID}:\${AGENT_GID}

WORKDIR /home/agent

# In worktree sandbox mode, Isolator bind-mounts the git worktree at ${SANDBOX_REPO_DIR}
# and overrides the working directory to ${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that ${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const CODEX_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{BACKLOG_MANAGER_TOOLS}}

# Build-args for UID/GID alignment: isolator docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -g $AGENT_GID node && usermod -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

# Install Codex CLI (run as root before USER agent)
RUN npm install -g @openai/codex

USER \${AGENT_UID}:\${AGENT_GID}

WORKDIR /home/agent

# In worktree sandbox mode, Isolator bind-mounts the git worktree at ${SANDBOX_REPO_DIR}
# and overrides the working directory to ${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that ${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const OPENCODE_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{BACKLOG_MANAGER_TOOLS}}

# Build-args for UID/GID alignment: isolator docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -g $AGENT_GID node && usermod -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

# Install OpenCode CLI (run as root before USER agent)
RUN npm install -g opencode-ai@latest

USER \${AGENT_UID}:\${AGENT_GID}

WORKDIR /home/agent

# In worktree sandbox mode, Isolator bind-mounts the git worktree at \${SANDBOX_REPO_DIR}
# and overrides the working directory to \${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that \${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const AGENT_REGISTRY: readonly AgentEntry[] = [
  {
    name: "claude-code",
    label: "Claude Code",
    defaultModel: "claude-opus-4-7",
    factoryImport: "claudeCode",
    dockerfileTemplate: CLAUDE_CODE_DOCKERFILE,
    envExample: `# Claude Code authentication — set ONE of the following.
#
# Recommended: use your Claude Pro/Max subscription. Run \`claude setup-token\`
# on the host once, then paste the long-lived token here:
CLAUDE_CODE_OAUTH_TOKEN=
#
# Alternative: an Anthropic API key (billed per token):
# ANTHROPIC_API_KEY=`,
  },
  {
    name: "pi",
    label: "Pi",
    defaultModel: "claude-sonnet-4-6",
    factoryImport: "pi",
    dockerfileTemplate: PI_DOCKERFILE,
    envExample: `# Anthropic API key
ANTHROPIC_API_KEY=`,
  },
  {
    name: "codex",
    label: "Codex",
    defaultModel: "gpt-5.4-mini",
    factoryImport: "codex",
    dockerfileTemplate: CODEX_DOCKERFILE,
    envExample: `# OpenAI API key
OPENAI_KEY=`,
  },
  {
    name: "opencode",
    label: "OpenCode",
    defaultModel: "opencode/big-pickle",
    factoryImport: "opencode",
    dockerfileTemplate: OPENCODE_DOCKERFILE,
    envExample: `# OpenCode API key
OPENCODE_API_KEY=`,
  },
];

export const listAgents = (): readonly AgentEntry[] => AGENT_REGISTRY;

export const getAgent = (name: string): AgentEntry | undefined =>
  AGENT_REGISTRY.find((a) => a.name === name);

// ---------------------------------------------------------------------------
// Backlog manager registry
// ---------------------------------------------------------------------------

export interface BacklogManagerEntry {
  readonly name: string;
  readonly label: string;
  /** Commands brain pipelines can use to interact with the backlog. */
  readonly commands: {
    readonly listTasks: string;
    readonly viewTask: string;
    readonly closeTask: string;
  };
  /** Dockerfile snippet that installs the manager's CLI tools. */
  readonly dockerfileTools: string;
  /** Lines to append to `~/.isolator/.env.example` (empty if none). */
  readonly envExample: string;
}

const GITHUB_CLI_TOOLS = `# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \\
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \\
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \\
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \\
  && apt-get update && apt-get install -y gh \\
  && rm -rf /var/lib/apt/lists/*`;

const BEADS_TOOLS = `# Install system dependencies for Beads
RUN apt-get update && apt-get install -y \\
  dpkg-dev \\
  libicu72 \\
  && rm -rf /var/lib/apt/lists/* \\
  && ARCH_DIR=$(dpkg-architecture -qDEB_HOST_MULTIARCH) \\
  && for lib in /usr/lib/$ARCH_DIR/libicu*.so.72; do \\
       ln -s "$lib" "\${lib%.72}.74"; \\
     done

RUN curl -fsSL https://raw.githubusercontent.com/steveyegge/beads/main/scripts/install.sh | bash

RUN corepack enable`;

const BACKLOG_MANAGER_REGISTRY: readonly BacklogManagerEntry[] = [
  {
    name: "github-issues",
    label: "GitHub Issues",
    commands: {
      listTasks: `gh issue list --state open --label Isolator --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`,
      viewTask: "gh issue view <ID>",
      closeTask: `gh issue close <ID> --comment "Completed by Isolator"`,
    },
    dockerfileTools: GITHUB_CLI_TOOLS,
    envExample: `# GitHub personal access token
GH_TOKEN=`,
  },
  {
    name: "beads",
    label: "Beads",
    commands: {
      listTasks: "bd ready --json",
      viewTask: "bd show <ID>",
      closeTask: `bd close <ID> "Completed by Isolator"`,
    },
    dockerfileTools: BEADS_TOOLS,
    envExample: "",
  },
];

export const listBacklogManagers = (): readonly BacklogManagerEntry[] =>
  BACKLOG_MANAGER_REGISTRY;

export const getBacklogManager = (
  name: string,
): BacklogManagerEntry | undefined =>
  BACKLOG_MANAGER_REGISTRY.find((b) => b.name === name);

// ---------------------------------------------------------------------------
// Sandbox provider registry
// ---------------------------------------------------------------------------

export interface SandboxProviderEntry {
  readonly name: string;
  readonly label: string;
  /** Filename written to `<project-repo>/.isolator/`. */
  readonly containerfileName: string;
  /** CLI namespace for build/remove commands. */
  readonly cliNamespace: string;
}

const SANDBOX_PROVIDER_REGISTRY: readonly SandboxProviderEntry[] = [
  {
    name: "docker",
    label: "Docker",
    containerfileName: "Dockerfile",
    cliNamespace: "docker",
  },
  {
    name: "podman",
    label: "Podman",
    containerfileName: "Containerfile",
    cliNamespace: "podman",
  },
];

export const listSandboxProviders = (): readonly SandboxProviderEntry[] =>
  SANDBOX_PROVIDER_REGISTRY;

export const getSandboxProvider = (
  name: string,
): SandboxProviderEntry | undefined =>
  SANDBOX_PROVIDER_REGISTRY.find((p) => p.name === name);

// ---------------------------------------------------------------------------
// Dockerfile rendering
// ---------------------------------------------------------------------------

/**
 * Render the Dockerfile (or Containerfile) text for a connected project:
 * picks the agent's template and substitutes the backlog manager's
 * `BACKLOG_MANAGER_TOOLS` snippet.
 */
export function renderDockerfile(
  agent: AgentEntry,
  backlogManager: BacklogManagerEntry,
): string {
  return agent.dockerfileTemplate.replace(
    /\{\{BACKLOG_MANAGER_TOOLS\}\}/g,
    backlogManager.dockerfileTools,
  );
}
