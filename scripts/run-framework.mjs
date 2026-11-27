import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { readExecutionProfile } from "./execution-profile.mjs";

const [command, ...args] = process.argv.slice(2);
if (!["dev", "build"].includes(command))
  throw new Error("Expected dev or build.");
const managedLinux = readExecutionProfile() === "managed-linux";
// Local passwords and the random signing key stay in the ignored .env file.
if (command === "dev" && !managedLinux) {
  const path = new URL("../.env", import.meta.url);
  const present = existsSync(path);
  const original = present ? readFileSync(path, "utf8") : "";
  const env = parseEnv(original);
  let settings = original;
  if (!present || env.APP_PASSWORD === "" || env.APP_PASSWORD === "6969") {
    const password = `APP_PASSWORD=${randomBytes(24).toString("base64url")}`;
    settings = settings.replace(/^[ \t]*(?:export[ \t]+)?APP_PASSWORD[ \t]*=.*\r?\n?/gm, "");
    settings += `\n${password}\n`;
  }
  if ((env.APP_SESSION_SECRET?.length ?? 0) < 32) {
    settings += `\nAPP_SESSION_SECRET=${randomBytes(32).toString("hex")}\n`;
  }
  if (present && process.platform !== "win32") chmodSync(path, 0o600);
  if (settings !== original) {
    writeFileSync(path, settings, { mode: 0o600 });
  }
  const { migrateLocal } = await import("./migrate-local.mjs");
  await migrateLocal();
}

if (managedLinux && command === "build") {
  const result = spawnSync(
    "bash",
    [fileURLToPath(new URL("./build-verified.sh", import.meta.url)), ...args],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

// Import in this process so the preview owner retains its PID and signals.
const cli = new URL(
  managedLinux
    ? "../node_modules/vite/bin/vite.js"
    : "../node_modules/vinext/dist/cli.js",
  import.meta.url,
);
process.argv = [
  process.execPath,
  fileURLToPath(cli),
  command,
  ...(!managedLinux && command === "dev" ? ["--port", "5173"] : []),
  ...args,
];
await import(cli.href);
