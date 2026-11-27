import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, globSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const port = process.env.TRACE_TEST_PORT || "5173";
const url = `http://127.0.0.1:${port}`;
async function isRunning() {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}
function stop() {
  return execFileSync(process.execPath, ["scripts/stop-local.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
}
async function waitFor(expected) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if ((await isRunning()) === expected) return;
    await delay(150);
  }
  assert.fail(`Local server did not become ${expected ? "ready" : "stopped"}.`);
}
test(
  "localhost lifecycle and .env password rotation work without losing the environment",
  { timeout: 90000 },
  async () => {
    assert.equal(
      await isRunning(),
      false,
      "Stop the existing local server before running this lifecycle check.",
    );
    assert.match(stop(), /already stopped/);
    const envPath = new URL("../.env", import.meta.url),
      originalEnv = readFileSync(envPath, "utf8");
    const originalPassword = originalEnv
      .match(/^APP_PASSWORD=(.*)$/m)?.[1]
      .trim();
    const rotatedPassword = "local-rotation-test-" + Date.now();
    const tokens = [];
    let oldCookie = "";
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt === 1)
          writeFileSync(
            envPath,
            originalEnv.replace(
              /^APP_PASSWORD=.*$/m,
              `APP_PASSWORD=${rotatedPassword}`,
            ),
          );
        const child = spawn(
          process.execPath,
          ["scripts/run-framework.mjs", "dev", "--port", port],
          { cwd: root, stdio: "ignore" },
        );
        try {
          await waitFor(true);
          for (const path of ["/.env", "/.vinext/dev/lock.json", "/dist/server/wrangler.json"]) {
            const blocked = await fetch(url + path);
            assert.ok([403, 404].includes(blocked.status), `Private file exposed at ${path}`);
          }
          const response = await fetch(`${url}/api/workspace`);
          assert.equal(response.status, 401);
          assert.match((await response.json()).error, /locked|session/i);
          if (attempt === 1) {
            const old = await fetch(`${url}/api/auth/session`, {
              headers: { Cookie: oldCookie },
            });
            assert.equal(
              old.status,
              401,
              "Changing .env invalidates the prior session",
            );
            const rejected = await fetch(`${url}/api/auth/login`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ password: originalPassword }),
            });
            assert.equal(rejected.status, 401);
          }
          const login = await fetch(`${url}/api/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              password: attempt === 0 ? originalPassword : rotatedPassword,
            }),
          });
          assert.equal(login.status, 200);
          const cookie = login.headers.get("set-cookie").split(";")[0];
          tokens.push(cookie);
          if (attempt === 0) oldCookie = cookie;
          assert.equal(
            (
              await fetch(`${url}/api/auth/session`, {
                headers: { Cookie: cookie },
              })
            ).status,
            200,
          );

          assert.match(stop(), /Stopping the local server/);
          await waitFor(false);
          assert.match(stop(), /already stopped/);
        } finally {
          if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGTERM");
        }
      }
    } finally {
      writeFileSync(envPath, originalEnv);
      for (const path of globSync(".wrangler/state/v3/d1/**/*.sqlite").filter(
        (p) => !p.endsWith("metadata.sqlite"),
      )) {
        const db = new DatabaseSync(path);
        try {
          db.exec("PRAGMA busy_timeout=5000");
          for (const cookie of tokens) {
            const payload = cookie.split("=")[1].split(".")[0];
            const { id } = JSON.parse(
              Buffer.from(payload, "base64url").toString(),
            );
            db.prepare("DELETE FROM sessions WHERE id=? AND owner=?").run(
              id,
              "local_seedy",
            );
          }
        } finally {
          db.close();
        }
      }
    }
  },
);
