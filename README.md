<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://res.cloudinary.com/total-typescript/image/upload/v1775033787/readme-isolator-ondark_2x.png">
    <source media="(prefers-color-scheme: light)" srcset="https://res.cloudinary.com/total-typescript/image/upload/v1775033787/readme-isolator-onlight_2x.png">
    <img alt="Isolator" src="https://res.cloudinary.com/total-typescript/image/upload/v1775033787/readme-isolator-onlight_2x.png" height="200" style="margin-bottom: 20px;">
  </picture>
</div>

## What Is Isolator?

Isolator runs AI coding agents as **brain-driven, repeatable software-development
pipelines**. A _brain_ is an Obsidian-style Markdown vault — skills, roles, rules,
and per-project notes. A _pipeline_ is a TypeScript script that drives a project
through one or more sandboxed agent steps, each pulling scoped context from the
brain and writing a typed artifact back.

The flow:

1. **`isolator brain new`** scaffolds a brain vault.
2. **`isolator connect <project>`** links a code repo to the brain and records how
   it should run (agent, model, sandbox, backlog manager).
3. **`isolator pipeline <name> <project>`** runs a pipeline: each step compiles
   context, composes a prompt, runs an agent in an isolated sandbox, writes the
   artifact into the vault, validates it, and logs telemetry.

Agents run in isolated sandboxes — Docker, Podman, or Vercel — so nothing touches
your host except the artifacts the brain writes back.

> **Embedding the engine directly?** Isolator still exports a lower-level
> programmatic API (`run()`, `createSandbox()`, `createWorktree()`) for a bare
> embed path with no brain, no vault, and no telemetry. That surface is documented
> separately in **[docs/library-api.md](docs/library-api.md)**.

## The three repo types

| Repo                    | What it holds                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **isolator**            | The tool itself — the execution core plus the brain layer (`src/brain/`) and pipelines (`src/pipelines/`).                      |
| **Brain vault**         | One shared Markdown vault: skills, roles, rules, and `projects/<slug>/` (overview, artifacts, runs, telemetry). No source code. |
| **Project source repo** | One per project: runnable code plus a slim `.isolator/Dockerfile` describing that project's sandbox image.                      |

A project links a vault folder to a code repo. The mapping is **split**: the
machine-independent git remote URL lives in the vault (`overview.md` frontmatter);
the machine-specific local checkout path and run settings live in
`~/.isolator/config.yml`.

## Prerequisites

- [Git](https://git-scm.com/)
- A sandbox provider — an isolated environment to run agents in:
  - [Docker Desktop](https://www.docker.com/) — most common for local development
  - [Podman](https://podman.io/) — rootless alternative to Docker
  - [Vercel](https://vercel.com/) — cloud Firecracker microVMs via `@vercel/sandbox`
- An agent CLI credential (see [Authentication](#authentication)).

## Quick start

1. Install the package:

   ```bash
   pnpm add -D isolator
   ```

2. Create a brain vault (the rare, one-time step):

   ```bash
   isolator brain new          # defaults to ~/brain
   ```

3. Set up authentication once — put your credential in `~/.isolator/.env`
   (see [Authentication](#authentication)).

4. Connect a project. `connect` interactively asks for the agent, sandbox,
   backlog manager, and default pipeline, then drops a `.isolator/Dockerfile`
   into the project repo and registers everything in `~/.isolator/config.yml`:

   ```bash
   isolator connect my-project --repo ./my-project
   ```

5. Build the project's sandbox image (image name is `isolator:<slug>` by
   convention, built from the project's `.isolator/Dockerfile`):

   ```bash
   cd my-project && isolator docker build-image
   ```

6. Run a pipeline:

   ```bash
   isolator pipeline echo my-project
   ```

   The `echo` pipeline is a one-step connectivity smoke test — it runs an agent
   in a sandbox and writes `projects/my-project/echo.md` into the vault.

## How it works

### `runStep()` — the brain primitive

Isolator's low-level unit is a raw `run()`. The brain's unit is a **brain-backed
step** — `runStep()`:

1. **Compile context** — glob the vault, stage only the files the step needs,
   write a `context-manifest.yml`.
2. **Compose the prompt** — `system/base.md` + role + skills + generated sections
   (objective, output contract, verification, failure policy).
3. **Run the agent** — execute in the project's sandbox via the execution core.
4. **Write artifacts** — map outputs to vault paths, inject artifact frontmatter
   (lineage + lifecycle), write back into the vault.
5. **Validate** — run named predicates against the artifacts.
6. **Telemetry** — append a record to `system/runs.jsonl`.

### Pipelines are TypeScript

A pipeline is a plain function: it takes a project slug, calls one or more
`runStep()`s, and returns the final result. Parallel, conditional, fan-out, and
data-passing are just TypeScript — there is no YAML engine.

```ts
// src/pipelines/discovery-to-prd.ts
import { runStep, gate } from "../brain/index.ts";

export async function discoveryToPrd(project: string) {
  const prd = await runStep({
    project,
    id: "prd",
    skill: "prd",
    role: "prd-griller",
    context: ["projects/$slug/discovery/**", "rules/product/*"],
    output: { type: "prd", path: "prd/PRD.md" },
    validate: ["all_required_outputs_exist", "prd_has_required_sections"],
  });
  await gate("scope_approval", prd); // pause; `continue` resumes
  return prd;
}
```

Pipelines live in `src/pipelines/` and are registered by name. `gate()` throws a
`PausedForApproval` the CLI catches; re-running the pipeline short-circuits
already-completed steps.

## CLI commands

The CLI is brain-first. Five verbs cover the brain flow (`brain new`, `connect`,
`pipeline`, `status`, `continue`); the `docker` / `podman` namespaces remain as
per-project image utilities.

### `isolator brain new [path]`

Scaffolds a fresh brain vault (`system/`, `skills/`, `roles/`, `rules/`,
`projects/`, a starter `system/base.md`, an empty `system/runs.jsonl`). Defaults
to `~/brain`. Records the vault as the configured brain in `~/.isolator/config.yml`.
This is the rare path — most of the time you connect projects to a brain that
already exists.

### `isolator connect <project>`

Connects a project to the brain. Creates (or links) the project source repo,
scaffolds `brain/projects/<slug>/`, drops a `.isolator/Dockerfile` into the repo,
and registers the project in `~/.isolator/config.yml`. Prompts interactively for
any choice not passed as a flag.

| Option                   | Default               | Description                                               |
| ------------------------ | --------------------- | --------------------------------------------------------- |
| `--repo`                 | —                     | Path to an existing project source repo to link           |
| `--new-repo`             | `./<slug>`            | Create a new project source repo at this path             |
| `--brain`                | configured brain      | Path to an existing brain vault to connect to             |
| `--new-brain`            | —                     | Create a new brain vault at this path                     |
| `--agent`                | interactive prompt    | Agent provider (`claude-code`, `pi`, `codex`, `opencode`) |
| `--sandbox`              | interactive prompt    | Sandbox provider (`docker`, `podman`)                     |
| `--model`                | agent's default model | Model id (e.g. `claude-opus-4-7`)                         |
| `--backlog-manager`      | interactive prompt    | Backlog manager (`github-issues`, `beads`)                |
| `--pipeline`             | interactive prompt    | Default pipeline name for this project                    |
| `--overwrite-dockerfile` | `false`               | Overwrite the project's `.isolator/Dockerfile` if present |

A brain is never created automatically — pass `--new-brain` to create one, or run
`isolator brain new` first.

### `isolator pipeline <name> <project>`

Runs a registered pipeline against a connected project. Steps that already
completed are short-circuited — re-running a pipeline replays instantly up to
the first unfinished step. When the pipeline pauses at an approval gate it stops
and points you at `isolator continue`.

### `isolator status <project>`

Prints where a project stands: its lifecycle status, the pipeline driving it,
the current step and any blocker (from `overview.md`), and a summary of the most
recent run (from `system/runs.jsonl`).

### `isolator continue <project>`

Resumes the project's default pipeline. Completed steps short-circuit; if the
pipeline is paused at an approval gate, `continue` approves that artifact and
re-runs so the pipeline proceeds to the next gate or to completion. The pipeline
is resolved from the project's `--pipeline` choice (or the last one that ran).

### `isolator docker build-image` / `isolator podman build-image`

Builds the project's sandbox image from its `.isolator/Dockerfile` (run from
inside the project repo). Image name defaults to `isolator:<repo-dir-name>`. On
Linux/macOS the build passes `--build-arg AGENT_UID=$(id -u)` / `AGENT_GID=$(id -g)`
so the image's `agent` user matches the host UID.

| Option            | Default                    | Description                                  |
| ----------------- | -------------------------- | -------------------------------------------- |
| `--image-name`    | `isolator:<repo-dir-name>` | Image name                                   |
| `--dockerfile`    | `.isolator/Dockerfile`     | Path to a custom Dockerfile (docker only)    |
| `--containerfile` | `.isolator/Containerfile`  | Path to a custom Containerfile (podman only) |

### `isolator docker remove-image` / `isolator podman remove-image`

Removes the project's sandbox image. Accepts `--image-name`.

## Authentication

Isolator forwards credentials into the sandbox from the **central**
`~/.isolator/.env` file (mode `600`). Only keys present in that file are
forwarded; `process.env` is consulted as a fallback for declared-but-empty keys.

### Claude Code via a Pro/Max subscription (recommended)

Use your Claude subscription instead of a per-token API key:

1. Run `claude setup-token` on the host once — it does the OAuth flow and yields a
   long-lived token.
2. Put it in `~/.isolator/.env`:

   ```bash
   CLAUDE_CODE_OAUTH_TOKEN=<token>
   ```

3. Leave `ANTHROPIC_API_KEY` unset. Isolator forwards the token into the sandbox;
   `claude` authenticates against the subscription, no API-key billing.

### API keys

Alternatively set the relevant API key in `~/.isolator/.env`
(`ANTHROPIC_API_KEY`, `OPENAI_KEY`, `OPENCODE_API_KEY`, …). The project's
Dockerfile, scaffolded by `connect`, documents which key its agent needs.

## Sandbox image (`.isolator/Dockerfile`)

`connect` scaffolds a `.isolator/Dockerfile` into each project repo. The default
image installs Node.js 22, `git`, `curl`, `jq`, the chosen agent's CLI, the
backlog manager's tooling, and a non-root `agent` user. The image is per-project
on purpose — a Rust project's container is not a Node project's container.

When customizing it, keep:

- A non-root user (the default `agent` user) for the agent to run as.
- `git` (required for commits and branch operations).
- The agent CLI installed and on `PATH`.

Rebuild after edits with `isolator docker build-image` (or `podman build-image`).

## Development

```bash
pnpm install
pnpm test          # Run tests with vitest
pnpm run typecheck # Type-check with tsgo
```

TypeScript is run natively by Node — no build step, no `tsx`.

## License

MIT
