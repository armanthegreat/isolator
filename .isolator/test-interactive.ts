import * as isolator from "isolator";
import { noSandbox } from "isolator/sandboxes/no-sandbox";

// /matt-pococks-projects/isolator
const { commits, branch } = await isolator.interactive({
  branchStrategy: {
    type: "merge-to-head",
  },
  name: "Test",
  agent: isolator.claudeCode("claude-sonnet-4-6"),
  prompt: "Add /foobar to the .gitignore, then commit.",
  copyToWorkspace: ["node_modules"],
});

console.log("Commits:", commits);
console.log("Branch:", branch);
