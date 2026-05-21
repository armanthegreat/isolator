import type { StagedContextFile } from "./context-compiler.ts";
import type { Skill } from "./skills.ts";
import type { StepOutput } from "./schemas.ts";

/**
 * Compose the single prompt string `isolator.run()` consumes.
 *
 * Pure: no IO, no globbing, no schema decoding. The orchestrator loads each
 * input (base prelude, role, skills, compiled context) and hands them here in
 * declaration order. The composer concatenates them in a *fixed* section
 * order so the agent's expectations don't drift between steps.
 *
 * Fixed section order:
 *
 *   1. Base system prompt (`system/base.md`)
 *   2. Role
 *   3. Skills (in declaration order)
 *   4. Staged context (the files the context compiler selected, grouped by
 *      vault top-level: `rules/`, `projects/<slug>/`, anything else)
 *   5. Objective (the step's `prompt`)
 *   6. Output contract (artifact list + `<step_output>` tag rules)
 *   7. Verification (the names of validators that will run)
 *   8. Failure policy (what to do when blocked)
 */

/** Required tag wrapping the agent's primary artifact. */
export const OUTPUT_TAG = "step_output";

/** Inputs to {@link composePrompt}. */
export interface PromptStackInputs {
  /** Contents of `system/base.md`. */
  readonly base: string;
  /** Loaded role (markdown + id), if the step has one. */
  readonly role?: { readonly id: string; readonly markdown: string };
  /** Loaded skill bundles in declaration order. */
  readonly skills?: readonly Skill[];
  /** Compiled context files, in glob order (path + contents). */
  readonly context?: readonly StagedContextFile[];
  /** The step's objective — the agent's main instruction. */
  readonly objective: string;
  /** Artifacts the step must produce. */
  readonly output: readonly StepOutput[];
  /** Names of validators that will run after the step. */
  readonly validate?: readonly string[];
}

/** Section delimiter inside the composed prompt. */
const SECTION_RULE = "\n\n---\n\n";

const renderSkills = (skills: readonly Skill[] | undefined): string => {
  if (!skills?.length) return "";
  const blocks = skills.map(
    (skill) => `## Skill: ${skill.id}\n\n${skill.markdown.trim()}`,
  );
  return `# Skills\n\n${blocks.join("\n\n")}`;
};

const groupContext = (
  files: readonly StagedContextFile[],
): Map<string, StagedContextFile[]> => {
  const groups = new Map<string, StagedContextFile[]>();
  for (const file of files) {
    const slash = file.path.indexOf("/");
    const top = slash === -1 ? file.path : file.path.slice(0, slash);
    const bucket = groups.get(top);
    if (bucket) bucket.push(file);
    else groups.set(top, [file]);
  }
  return groups;
};

const renderContext = (
  files: readonly StagedContextFile[] | undefined,
): string => {
  if (!files?.length) return "";
  const groups = groupContext(files);
  const sections: string[] = [];
  for (const [top, group] of groups) {
    const heading = `## Context: ${top}/`;
    const blocks = group.map(
      (file) =>
        `### ${file.path}\n\n\`\`\`\n${file.contents.trimEnd()}\n\`\`\``,
    );
    sections.push(`${heading}\n\n${blocks.join("\n\n")}`);
  }
  return `# Staged context\n\n${sections.join("\n\n")}`;
};

const renderOutputContract = (output: readonly StepOutput[]): string => {
  const list = output
    .map((entry) => `- \`${entry.path}\` (\`${entry.type}\`)`)
    .join("\n");
  return `# Output contract

Produce every artifact listed below at the exact vault-relative path given:

${list}

When you have written each file inside the workspace, emit the *primary*
artifact's contents wrapped in a single output tag:

<${OUTPUT_TAG}>
contents of the primary artifact
</${OUTPUT_TAG}>

Write nothing after the closing </${OUTPUT_TAG}> tag.`;
};

const renderVerification = (
  validate: readonly string[] | undefined,
): string => {
  if (!validate?.length) return "";
  const list = validate.map((name) => `- \`${name}\``).join("\n");
  return `# Verification

The following validators will run against your artifacts after the step
completes:

${list}

A step that fails validation is reported as failed regardless of its output.`;
};

const FAILURE_POLICY = `# Failure policy

- Never fabricate facts, citations, file contents, or APIs. If something is
  unknown, surface it as an open question instead of guessing.
- Prefer evidence from the staged context over assumption.
- If you cannot produce a required artifact, write what you can, record what
  is blocking you, and stop. Do not emit a partial result that looks complete.`;

/**
 * Compose the final prompt. Section order is fixed; empty sections are
 * skipped so a minimal step doesn't ship trailing dividers.
 */
export const composePrompt = (inputs: PromptStackInputs): string => {
  const sections: string[] = [];
  const push = (section: string) => {
    if (section.trim() !== "") sections.push(section.trim());
  };

  push(inputs.base);
  if (inputs.role) push(`# Role: ${inputs.role.id}\n\n${inputs.role.markdown}`);
  push(renderSkills(inputs.skills));
  push(renderContext(inputs.context));
  push(`# Objective\n\n${inputs.objective}`);
  push(renderOutputContract(inputs.output));
  push(renderVerification(inputs.validate));
  push(FAILURE_POLICY);

  return sections.join(SECTION_RULE);
};
