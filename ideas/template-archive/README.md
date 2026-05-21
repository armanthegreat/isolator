# Template archive

Reference seed material from isolator's pre-brain era. **Not live code** — these
files are not imported, scaffolded, or shipped. They live here so Phase 5 (and
beyond) can mine them when authoring brain skills, roles, and pipelines.

## What's here

### Orchestration patterns (`./blank/`, `./simple-loop/`, `./parallel-planner/`, `./parallel-planner-with-review/`, `./sequential-reviewer/`)

The five templates `isolator init` used to scaffold into a project's `.isolator/`.
Each is a self-contained TypeScript orchestration script (`main.mts`) plus its
prompts. Useful as concrete examples when porting a pattern onto `runStep()`:

- **blank** — minimal one-shot.
- **simple-loop** — single agent iterates until done.
- **parallel-planner** — split into N parallel planners, then merge.
- **parallel-planner-with-review** — parallel-planner + a review pass.
- **sequential-reviewer** — implement → review → loop.

### Dogfood prompts (`./dogfood/`)

The prompts this repo itself used to drive `parallel-planner-with-review`:
`plan-prompt.md`, `implement-prompt.md`, `review-prompt.md`, `merge-prompt.md`,
plus a `CODING_STANDARDS.md` they all referenced. Good first-draft material for
brain skills (`skills/plan/SKILL.md`, `skills/review/SKILL.md`, …) and roles.

## Lifecycle

Live code under `src/brain/` + `src/pipelines/` is the source of truth. If a
pattern here proves useful, port the relevant bits into a real brain pipeline —
do not import from this directory. The archive is read-only reference.
