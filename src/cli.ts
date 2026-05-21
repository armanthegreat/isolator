import { Args, Command, Options } from "@effect/cli";
import { FileSystem } from "@effect/platform";
import { Effect, Option } from "effect";
import * as clack from "@clack/prompts";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { styleText } from "node:util";

import { Display } from "./Display.ts";
import { buildImage, removeImage } from "./DockerLifecycle.ts";
import {
  buildImage as podmanBuildImage,
  removeImage as podmanRemoveImage,
} from "./PodmanLifecycle.ts";
import { defaultImageName } from "./sandboxes/docker.ts";
import { ConfigDirError, InitError } from "./errors.ts";
import {
  type AgentEntry,
  type BacklogManagerEntry,
  connectProject,
  createBrain,
  defaultIsolatorHomeLayer,
  formatBrainError,
  getAgent,
  getBacklogManager,
  getSandboxProvider,
  listAgents,
  listBacklogManagers,
  listSandboxProviders,
  type SandboxProviderEntry,
} from "./brain/index.ts";
import { pipelines } from "./pipelines/index.ts";

const require = createRequire(import.meta.url);
const VERSION = (require("../package.json") as { version: string }).version;

// --- Shared options ---

const imageNameOption = Options.text("image-name").pipe(
  Options.withDescription("Docker image name"),
  Options.optional,
);

const resolveImageName = (
  cliFlag: import("effect").Option.Option<string>,
  cwd: string,
): string => (cliFlag._tag === "Some" ? cliFlag.value : defaultImageName(cwd));

// --- UID build-args ---

/** Build-args that align the image UID/GID to the host (Linux/macOS). No-op on Windows. */
const defaultUidBuildArgs = (): Record<string, string> => {
  const args: Record<string, string> = {};
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid !== undefined) args.AGENT_UID = String(uid);
  if (gid !== undefined) args.AGENT_GID = String(gid);
  return args;
};

// --- Config directory check ---

const CONFIG_DIR = ".isolator";

const requireConfigDir = (
  cwd: string,
): Effect.Effect<void, ConfigDirError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs
      .exists(join(cwd, CONFIG_DIR))
      .pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (!exists) {
      yield* Effect.fail(
        new ConfigDirError({
          message:
            "No .isolator/ found. Connect this repo with `isolator connect <project>` first.",
        }),
      );
    }
  });

// --- Build-image command (per-project Docker image utility) ---

const dockerfileOption = Options.file("dockerfile").pipe(
  Options.withDescription(
    "Path to a custom Dockerfile (build context will be the current working directory)",
  ),
  Options.optional,
);

const buildImageCommand = Command.make(
  "build-image",
  {
    imageName: imageNameOption,
    dockerfile: dockerfileOption,
  },
  ({ imageName: imageNameFlag, dockerfile }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      yield* requireConfigDir(cwd);

      const imageName = resolveImageName(imageNameFlag, cwd);

      const dockerfileDir = join(cwd, CONFIG_DIR);
      const dockerfilePath =
        dockerfile._tag === "Some" ? dockerfile.value : undefined;

      yield* d.spinner(
        `Building Docker image '${imageName}'...`,
        buildImage(imageName, dockerfileDir, {
          dockerfile: dockerfilePath,
          buildArgs: defaultUidBuildArgs(),
        }),
      );

      yield* d.status("Build complete!", "success");
    }),
);

// --- Remove-image command ---

const removeImageCommand = Command.make(
  "remove-image",
  {
    imageName: imageNameOption,
  },
  ({ imageName: imageNameFlag }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();

      const imageName = resolveImageName(imageNameFlag, cwd);

      yield* d.spinner(
        `Removing Docker image '${imageName}'...`,
        removeImage(imageName),
      );
      yield* d.status("Image removed.", "success");
    }),
);

// --- Docker namespace command ---

const dockerCommand = Command.make("docker", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(
      "Docker sandbox commands. Use --help to see available subcommands.",
      "info",
    );
  }),
).pipe(Command.withSubcommands([buildImageCommand, removeImageCommand]));

// --- Podman build-image command ---

const containerfileOption = Options.file("containerfile").pipe(
  Options.withDescription(
    "Path to a custom Containerfile (build context will be the current working directory)",
  ),
  Options.optional,
);

const podmanBuildImageCommand = Command.make(
  "build-image",
  {
    imageName: imageNameOption,
    containerfile: containerfileOption,
  },
  ({ imageName: imageNameFlag, containerfile }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      yield* requireConfigDir(cwd);

      const imageName = resolveImageName(imageNameFlag, cwd);

      const containerfileDir = join(cwd, CONFIG_DIR);
      const containerfilePath =
        containerfile._tag === "Some" ? containerfile.value : undefined;
      yield* d.spinner(
        `Building Podman image '${imageName}'...`,
        podmanBuildImage(imageName, containerfileDir, {
          containerfile: containerfilePath,
        }),
      );

      yield* d.status("Build complete!", "success");
    }),
);

// --- Podman remove-image command ---

const podmanRemoveImageCommand = Command.make(
  "remove-image",
  {
    imageName: imageNameOption,
  },
  ({ imageName: imageNameFlag }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();

      const imageName = resolveImageName(imageNameFlag, cwd);

      yield* d.spinner(
        `Removing Podman image '${imageName}'...`,
        podmanRemoveImage(imageName),
      );
      yield* d.status("Image removed.", "success");
    }),
);

// --- Podman namespace command ---

const podmanCommand = Command.make("podman", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(
      "Podman sandbox commands. Use --help to see available subcommands.",
      "info",
    );
  }),
).pipe(
  Command.withSubcommands([podmanBuildImageCommand, podmanRemoveImageCommand]),
);

// --- Brain commands ---

/** Map any brain-layer error to a friendly `InitError` for the CLI. */
const asInitError = <A, E extends Parameters<typeof formatBrainError>[0], R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, InitError, R> =>
  effect.pipe(
    Effect.catchAll((error) =>
      Effect.fail(new InitError({ message: formatBrainError(error) })),
    ),
  );

const brainPathArg = Args.text({ name: "path" }).pipe(
  Args.withDescription("Directory for the brain vault (default: ~/brain)"),
  Args.optional,
);

const brainNewCommand = Command.make(
  "new",
  { path: brainPathArg },
  ({ path }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const target = Option.getOrElse(path, () => join(homedir(), "brain"));
      const vaultPath = yield* asInitError(
        createBrain(target).pipe(Effect.provide(defaultIsolatorHomeLayer)),
      );
      yield* d.status(`Brain vault created at ${vaultPath}`, "success");
    }),
);

const brainCommand = Command.make("brain", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(
      "Brain commands. Use --help to see available subcommands.",
      "info",
    );
  }),
).pipe(Command.withSubcommands([brainNewCommand]));

const projectArg = Args.text({ name: "project" }).pipe(
  Args.withDescription("Project name (normalized to a slug)"),
);

const brainOption = Options.text("brain").pipe(
  Options.withDescription("Path to an existing brain vault to connect to"),
  Options.optional,
);

const newBrainOption = Options.text("new-brain").pipe(
  Options.withDescription("Create a new brain vault at this path"),
  Options.optional,
);

const repoOption = Options.text("repo").pipe(
  Options.withDescription("Path to an existing project source repo to link"),
  Options.optional,
);

const newRepoOption = Options.text("new-repo").pipe(
  Options.withDescription(
    "Create a new project source repo at this path (default: ./<slug>)",
  ),
  Options.optional,
);

const agentOption = Options.text("agent").pipe(
  Options.withDescription(
    "Agent provider id (claude-code | pi | codex | opencode)",
  ),
  Options.optional,
);

const sandboxOption = Options.text("sandbox").pipe(
  Options.withDescription("Sandbox provider (docker | podman)"),
  Options.optional,
);

const modelOption = Options.text("model").pipe(
  Options.withDescription(
    "Model id (e.g. claude-opus-4-7); defaults to the agent's default",
  ),
  Options.optional,
);

const backlogManagerOption = Options.text("backlog-manager").pipe(
  Options.withDescription("Backlog manager id (github-issues | beads)"),
  Options.optional,
);

const pipelineOption = Options.text("pipeline").pipe(
  Options.withDescription(
    "Default pipeline name for this project (e.g. echo, discovery-to-prd)",
  ),
  Options.optional,
);

const overwriteDockerfileOption = Options.boolean("overwrite-dockerfile").pipe(
  Options.withDescription(
    "Overwrite the project's .isolator/Dockerfile even if it already exists",
  ),
);

/**
 * Resolve a `--<flag>` choice against a named registry; fall back to interactive
 * selection when the flag is absent and stdin is a TTY. Returns `undefined` only
 * when the user cancels; callers fail the command in that case.
 */
const resolveSelection = <T extends { name: string; label: string }>(
  flagValue: Option.Option<string>,
  entries: readonly T[],
  lookup: (name: string) => T | undefined,
  prompt: {
    message: string;
    initialValue?: string;
    hint?: (entry: T) => string;
  },
): Effect.Effect<T, InitError> =>
  Effect.gen(function* () {
    if (flagValue._tag === "Some") {
      const entry = lookup(flagValue.value);
      if (entry === undefined) {
        const names = entries.map((e) => e.name).join(", ");
        return yield* Effect.fail(
          new InitError({
            message: `Unknown choice "${flagValue.value}". Available: ${names}`,
          }),
        );
      }
      return entry;
    }
    const selected = yield* Effect.promise(() =>
      clack.select({
        message: prompt.message,
        ...(prompt.initialValue !== undefined && {
          initialValue: prompt.initialValue,
        }),
        options: entries.map((e) => ({
          value: e.name,
          label: e.label,
          ...(prompt.hint !== undefined && { hint: prompt.hint(e) }),
        })),
      }),
    );
    if (clack.isCancel(selected)) {
      return yield* Effect.fail(
        new InitError({ message: `${prompt.message} cancelled.` }),
      );
    }
    return lookup(selected as string)!;
  });

const connectCommand = Command.make(
  "connect",
  {
    project: projectArg,
    brain: brainOption,
    newBrain: newBrainOption,
    repo: repoOption,
    newRepo: newRepoOption,
    agent: agentOption,
    sandbox: sandboxOption,
    model: modelOption,
    backlogManager: backlogManagerOption,
    pipeline: pipelineOption,
    overwriteDockerfile: overwriteDockerfileOption,
  },
  ({
    project,
    brain,
    newBrain,
    repo,
    newRepo,
    agent: agentFlag,
    sandbox: sandboxFlag,
    model: modelFlag,
    backlogManager: backlogFlag,
    pipeline: pipelineFlag,
    overwriteDockerfile,
  }) =>
    Effect.gen(function* () {
      const d = yield* Display;

      // Interactive selections (each falls back to its flag when present).
      const agent: AgentEntry = yield* resolveSelection(
        agentFlag,
        listAgents(),
        getAgent,
        {
          message: "Select an agent:",
          initialValue: "claude-code",
          hint: (a) => `Default model: ${a.defaultModel}`,
        },
      );
      const sandboxProvider: SandboxProviderEntry = yield* resolveSelection(
        sandboxFlag,
        listSandboxProviders(),
        getSandboxProvider,
        { message: "Select a sandbox provider:", initialValue: "docker" },
      );
      const backlogManager: BacklogManagerEntry = yield* resolveSelection(
        backlogFlag,
        listBacklogManagers(),
        getBacklogManager,
        {
          message: "Select a backlog manager:",
          initialValue: "github-issues",
        },
      );

      const pipelineNames = Object.keys(pipelines);
      const pipelineEntries = pipelineNames.map((name) => ({
        name,
        label: name,
      }));
      const defaultPipeline =
        pipelineFlag._tag === "Some"
          ? pipelineFlag.value
          : pipelineEntries.length === 0
            ? undefined
            : (yield* resolveSelection(
                Option.none(),
                pipelineEntries,
                (n) => pipelineEntries.find((p) => p.name === n),
                {
                  message: "Default pipeline for this project:",
                  initialValue: pipelineEntries[0]!.name,
                },
              )).name;

      const model =
        modelFlag._tag === "Some" ? modelFlag.value : agent.defaultModel;

      const result = yield* asInitError(
        connectProject({
          name: project,
          cwd: process.cwd(),
          brain: Option.getOrUndefined(brain),
          newBrain: Option.getOrUndefined(newBrain),
          repo: Option.getOrUndefined(repo),
          newRepo: Option.getOrUndefined(newRepo),
          agent: agent.name,
          sandbox: sandboxProvider.name,
          model,
          backlogManager: backlogManager.name,
          defaultPipeline,
          overwriteDockerfile,
        }).pipe(Effect.provide(defaultIsolatorHomeLayer)),
      );
      if (result.createdBrain) {
        yield* d.status(
          `Brain vault created at ${result.vaultPath}`,
          "success",
        );
      }
      yield* d.status(`Connected project "${result.slug}"`, "success");
      yield* d.text(styleText("dim", `  vault:      ${result.projectDir}`));
      yield* d.text(styleText("dim", `  repo:       ${result.repoPath}`));
      yield* d.text(styleText("dim", `  dockerfile: ${result.dockerfilePath}`));
      yield* d.text(
        styleText("dim", `  agent:      ${agent.label} (${model})`),
      );
      yield* d.text(
        styleText(
          "dim",
          `  sandbox:    ${sandboxProvider.label} (image: isolator:${result.slug})`,
        ),
      );
      yield* d.text(styleText("dim", `  backlog:    ${backlogManager.label}`));
      if (defaultPipeline !== undefined) {
        yield* d.text(styleText("dim", `  pipeline:   ${defaultPipeline}`));
      }
      yield* d.text(
        styleText(
          "dim",
          `\nNext: build the project image with \`isolator ${sandboxProvider.cliNamespace} build-image\` in ${result.repoPath}.`,
        ),
      );
    }),
);

// --- Pipeline command ---

const pipelineNameArg = Args.text({ name: "name" }).pipe(
  Args.withDescription("Pipeline to run (e.g. echo)"),
);

const pipelineCommand = Command.make(
  "pipeline",
  { name: pipelineNameArg, project: projectArg },
  ({ name, project }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const pipeline = pipelines[name];
      if (pipeline === undefined) {
        const names = Object.keys(pipelines).join(", ");
        yield* Effect.fail(
          new InitError({
            message: `Unknown pipeline "${name}". Available: ${names}`,
          }),
        );
      }
      const result = yield* Effect.tryPromise({
        try: () => pipeline!(project),
        catch: (cause) =>
          new InitError({
            message: `Pipeline "${name}" failed: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          }),
      });
      yield* d.status(`Pipeline "${name}" complete`, "success");
      yield* d.text(styleText("dim", `  run:      ${result.runId}`));
      yield* d.text(styleText("dim", `  artifact: ${result.artifactPath}`));
    }),
);

// --- Root command ---

const rootCommand = Command.make("isolator", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(`Isolator v${VERSION}`, "info");
    yield* d.status("Use --help to see available commands.", "info");
  }),
);

export const isolator = rootCommand.pipe(
  Command.withSubcommands([
    brainCommand,
    connectCommand,
    pipelineCommand,
    dockerCommand,
    podmanCommand,
  ]),
);

export const cli = Command.run(isolator, {
  name: "isolator",
  version: VERSION,
});
