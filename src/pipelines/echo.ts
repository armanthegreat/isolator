import { runStep, type StepResult } from "../brain/run-step.ts";

/**
 * The `echo` pipeline — a one-step connectivity smoke test for the brain.
 *
 * It runs a single brain step asking the agent to echo a fixed word, writes the
 * reply to `projects/<slug>/echo.md` in the vault, and appends a line to
 * `system/runs.jsonl`. This proves the brain↔isolator seam — sandbox,
 * subscription auth, structured output, and write-back — end to end.
 */
export const echo = (project: string): Promise<StepResult> =>
  runStep({
    project,
    id: "echo",
    prompt:
      "This is a connectivity smoke test for the isolator brain. " +
      "Reply with exactly the single word ISOLATOR — no punctuation, no extra text.",
    output: { type: "echo", path: "echo.md" },
  });
