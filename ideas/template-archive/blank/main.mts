import { run, claudeCode } from "isolator";
import { docker } from "isolator/sandboxes/docker";

// Blank template: customize this to build your own orchestration.
// Run this with: npx tsx .isolator/main.mts
// Or add to package.json scripts: "isolator": "npx tsx .isolator/main.mts"

await run({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: docker(),
  promptFile: "./.isolator/prompt.md",
});
