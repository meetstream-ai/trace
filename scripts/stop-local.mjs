import { readFileSync, readlinkSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
let state;
try {
  state = JSON.parse(readFileSync(new URL("../.vinext/dev/lock.json", import.meta.url), "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  console.log("The local server is already stopped.");
  process.exit(0);
}
if (!Number.isInteger(state.pid) || state.pid <= 1 || state.cwd !== root) {
  throw new Error("The server lock does not belong to this project; no process was stopped.");
}
try {
  process.kill(state.pid, 0);
} catch (error) {
  if (error.code !== "ESRCH") throw error;
  console.log("The local server is already stopped.");
  process.exit(0);
}
// Verify the live process directory, so a stale PID cannot stop another project.
const cwd = process.platform === "linux"
  ? readlinkSync(`/proc/${state.pid}/cwd`)
  : execFileSync("lsof", ["-a", "-p", String(state.pid), "-d", "cwd", "-Fn"], { encoding: "utf8" })
      .split("\n").find(line => line.startsWith("n"))?.slice(1);
const command = execFileSync("ps", ["-p", String(state.pid), "-o", "args="], { encoding: "utf8" });
if (cwd !== root || !/run-framework\.mjs\s+dev(?:\s|$)/.test(command)) {
  throw new Error("The recorded PID is not this project's development server; no process was stopped.");
}
process.kill(state.pid, "SIGTERM");
console.log(`Stopping the local server at ${state.appUrl}.`);
