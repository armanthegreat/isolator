import { describe, expect, it } from "vitest";
import type { StagedContextFile } from "./context-compiler.ts";
import { composePrompt, OUTPUT_TAG } from "./prompt-stack.ts";
import type { Skill } from "./skills.ts";

const minimal = () => ({
  base: "# Base system prompt\n\nbe honest",
  objective: "Draft a PRD for the demo project.",
  output: [
    { type: "prd", path: "prd/PRD.md" },
    { type: "open_questions", path: "discovery/open-questions.md" },
  ],
});

const skill = (id: string, body: string): Skill => ({
  id,
  path: `/tmp/${id}`,
  markdown: body,
  sidecars: [],
});

const ctxFile = (path: string, contents: string): StagedContextFile => ({
  path,
  reason: "test",
  bytes: Buffer.byteLength(contents, "utf8"),
  contents,
});

describe("composePrompt", () => {
  it("emits sections in the fixed order", () => {
    const out = composePrompt({
      ...minimal(),
      role: { id: "prd-griller", markdown: "you grill" },
      skills: [skill("prd", "skill body")],
      context: [ctxFile("rules/r.md", "rule body")],
      validate: ["all_required_outputs_exist"],
    });

    const idx = (h: string) => out.indexOf(h);
    expect(idx("# Base system prompt")).toBeGreaterThanOrEqual(0);
    expect(idx("# Base system prompt")).toBeLessThan(
      idx("# Role: prd-griller"),
    );
    expect(idx("# Role: prd-griller")).toBeLessThan(idx("# Skills"));
    expect(idx("# Skills")).toBeLessThan(idx("# Staged context"));
    expect(idx("# Staged context")).toBeLessThan(idx("# Objective"));
    expect(idx("# Objective")).toBeLessThan(idx("# Output contract"));
    expect(idx("# Output contract")).toBeLessThan(idx("# Verification"));
    expect(idx("# Verification")).toBeLessThan(idx("# Failure policy"));
  });

  it("skips empty sections instead of emitting blank dividers", () => {
    const out = composePrompt(minimal());

    expect(out).not.toContain("# Role:");
    expect(out).not.toContain("# Skills");
    expect(out).not.toContain("# Staged context");
    expect(out).not.toContain("# Verification");
    expect(out).toContain("# Objective");
    expect(out).toContain("# Output contract");
    expect(out).toContain("# Failure policy");
  });

  it("lists every output in the contract section", () => {
    const out = composePrompt(minimal());

    expect(out).toContain("`prd/PRD.md` (`prd`)");
    expect(out).toContain("`discovery/open-questions.md` (`open_questions`)");
    expect(out).toContain(`<${OUTPUT_TAG}>`);
    expect(out).toContain(`</${OUTPUT_TAG}>`);
  });

  it("groups staged context by vault top-level directory", () => {
    const out = composePrompt({
      ...minimal(),
      context: [
        ctxFile("rules/a.md", "A"),
        ctxFile("projects/demo/idea.md", "idea"),
        ctxFile("rules/b.md", "B"),
      ],
    });

    expect(out).toContain("## Context: rules/");
    expect(out).toContain("## Context: projects/");
    expect(out.indexOf("rules/a.md")).toBeLessThan(out.indexOf("rules/b.md"));
  });

  it("renders skills in declaration order", () => {
    const out = composePrompt({
      ...minimal(),
      skills: [skill("first", "F"), skill("second", "S")],
    });

    expect(out.indexOf("## Skill: first")).toBeLessThan(
      out.indexOf("## Skill: second"),
    );
  });

  it("renders the failure policy on every prompt", () => {
    const out = composePrompt(minimal());
    expect(out).toContain("Never fabricate");
  });
});
