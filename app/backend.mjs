import { spawn } from "node:child_process";
import path from "node:path";
import { mkdir } from "node:fs/promises";
export function createBackend({ root, binary }) {
  const children = new Set();
  return {
    async execute(workspaceId, action) {
      if (!/^[a-f0-9]{32}$/.test(workspaceId))
        throw new Error("Invalid workspace identity");
      const state = path.join(root, "wallets", workspaceId);
      await mkdir(state, { recursive: true, mode: 0o700 });
      return new Promise((resolve, reject) => {
        const child = spawn(binary, ["--state-dir", state, "workspace"], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { PATH: process.env.PATH },
        });
        children.add(child);
        let output = "";
        const timer = setTimeout(() => child.kill("SIGTERM"), 240000);
        child.stdout.on("data", (chunk) => {
          output += chunk;
          if (output.length > 2 * 1024 * 1024) child.kill("SIGTERM");
        });
        child.stderr.on("data", () => {});
        child.stdin.on("error", () => {});
        child.on("error", () => {
          clearTimeout(timer);
          children.delete(child);
          reject(new Error("Wallet service unavailable."));
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          children.delete(child);
          try {
            if (code !== 0)
              throw new Error(
                "Wallet operation interrupted. Your existing payment records are retained.",
              );
            const line = output
              .split("\n")
              .filter((l) => l.startsWith("WORKSPACE_RESULT:"))
              .at(-1);
            if (!line)
              throw new Error("Wallet operation did not return a result.");
            const result = JSON.parse(line.slice("WORKSPACE_RESULT:".length));
            if (!result.ok) throw new Error(result.error);
            resolve(result.result);
          } catch (error) {
            reject(error);
          }
        });
        child.stdin.end(JSON.stringify(action));
      });
    },
    stop() {
      for (const child of children) child.kill("SIGTERM");
    },
  };
}
