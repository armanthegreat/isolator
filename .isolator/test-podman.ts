import * as isolator from "isolator";
import { podman } from "isolator/sandboxes/podman";

const { commits, branch } = await isolator.run({
  sandbox: podman(),
  name: "Test",
  agent: isolator.claudeCode("claude-sonnet-4-6"),
  prompt: "Add /foobar to the .gitignore, then commit.",
  hooks: {
    sandbox: {
      onSandboxReady: [
        {
          command: "pnpm install",
        },
      ],
    },
  },
});

console.log("Commits:", commits);
console.log("Branch:", branch);
