import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSkill, loadSkills } from "./skills.ts";

const makeTmp = () => mkdtemp(join(tmpdir(), "isolator-skills-"));

const seed = async (vault: string, files: Record<string, string>) => {
  await mkdir(vault, { recursive: true });
  for (const [relPath, contents] of Object.entries(files)) {
    const absolute = join(vault, relPath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }
};

const runSkill = (vault: string, id: string) =>
  Effect.runPromise(
    loadSkill(vault, id).pipe(Effect.provide(NodeContext.layer)),
  );

const runSkills = (vault: string, ids: readonly string[]) =>
  Effect.runPromise(
    loadSkills(vault, ids).pipe(Effect.provide(NodeContext.layer)),
  );

const runSkillError = (vault: string, id: string) =>
  Effect.runPromise(
    loadSkill(vault, id).pipe(Effect.provide(NodeContext.layer), Effect.flip),
  );

describe("loadSkill", () => {
  it("loads the SKILL.md body", async () => {
    const vault = join(await makeTmp(), "brain");
    await seed(vault, { "skills/prd/SKILL.md": "# PRD skill" });

    const skill = await runSkill(vault, "prd");
    expect(skill.id).toBe("prd");
    expect(skill.markdown).toBe("# PRD skill");
    expect(skill.sidecars).toStrictEqual([]);
  });

  it("reports vault-relative sidecar paths in stable order", async () => {
    const vault = join(await makeTmp(), "brain");
    await seed(vault, {
      "skills/prd/SKILL.md": "# PRD",
      "skills/prd/templates/outline.md": "outline",
      "skills/prd/examples/sample.md": "sample",
    });

    const skill = await runSkill(vault, "prd");
    expect(skill.sidecars).toStrictEqual([
      "skills/prd/examples/sample.md",
      "skills/prd/templates/outline.md",
    ]);
  });

  it("fails with SkillError when the bundle is missing", async () => {
    const vault = join(await makeTmp(), "brain");
    await mkdir(join(vault, "skills"), { recursive: true });

    const error = await runSkillError(vault, "prd");
    expect(error._tag).toBe("SkillError");
    expect(error.skill).toBe("prd");
    expect(error.message).toContain("No SKILL.md");
  });

  it("fails with SkillError when SKILL.md is missing", async () => {
    const vault = join(await makeTmp(), "brain");
    await seed(vault, { "skills/prd/notes.md": "notes" });

    const error = await runSkillError(vault, "prd");
    expect(error._tag).toBe("SkillError");
    expect(error.message).toContain("No SKILL.md");
  });
});

describe("loadSkills", () => {
  it("loads several skills in declaration order", async () => {
    const vault = join(await makeTmp(), "brain");
    await seed(vault, {
      "skills/prd/SKILL.md": "# prd",
      "skills/no-fabrication/SKILL.md": "# no-fab",
    });

    const skills = await runSkills(vault, ["no-fabrication", "prd"]);
    expect(skills.map((s) => s.id)).toStrictEqual(["no-fabrication", "prd"]);
  });

  it("short-circuits on the first failure", async () => {
    const vault = join(await makeTmp(), "brain");
    await seed(vault, { "skills/prd/SKILL.md": "# prd" });

    const error = await Effect.runPromise(
      loadSkills(vault, ["prd", "missing"]).pipe(
        Effect.provide(NodeContext.layer),
        Effect.flip,
      ),
    );
    expect(error._tag).toBe("SkillError");
    expect(error.skill).toBe("missing");
  });
});
