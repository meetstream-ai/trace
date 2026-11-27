import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, globSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
const origin = process.env.TRACE_TEST_URL || "http://127.0.0.1:5173";
if (!["127.0.0.1", "localhost"].includes(new URL(origin).hostname))
  throw new Error("Local tests only.");
const password =
  process.env.APP_PASSWORD ||
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .match(/^APP_PASSWORD=(.*)$/m)?.[1]
    .trim();
let cookie = "";
async function request(path, method = "GET", body, headers = {}) {
  return fetch(origin + path, {
    method,
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const dbPath = globSync(".wrangler/state/v3/d1/**/*.sqlite").find(
  (p) => !p.endsWith("metadata.sqlite"),
);
test("password gate, revocable sessions, settings, encrypted connection storage and canonical deep links", async () => {
  const db = new DatabaseSync(dbPath);
  const originalPrefs = db
    .prepare("SELECT * FROM preferences WHERE owner=?")
    .get("local_seedy");
  const originalSlack = db
    .prepare(
      "SELECT * FROM integration_settings WHERE owner=? AND destination=?",
    )
    .get("local_seedy", "slack");
  let activeCookie = "";
  try {
    assert.equal((await request("/api/workspace")).status, 401);
    assert.equal(
      (
        await request("/api/workspace", "GET", undefined, {
          "oai-authenticated-user-id": "local_seedy",
        })
      ).status,
      401,
    );
    const redirect = await request("/workspace/profile");
    assert.equal(redirect.status, 307);
    assert.match(redirect.headers.get("location"), /\/login\?next=/);
    const meetingReturn =
      "/workspace/meetings/local_seedy%3Asample-api-v2?segment=s3";
    const deepLink = await request(meetingReturn);
    assert.equal(deepLink.status, 307);
    assert.equal(
      new URL(deepLink.headers.get("location"), origin).searchParams.get(
        "next",
      ),
      meetingReturn,
    );
    assert.equal(
      (
        await request("/api/auth/login", "POST", {
          password: "wrong-test-password",
        })
      ).status,
      401,
    );
    const login = await request("/api/auth/login", "POST", { password });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get("set-cookie");
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    cookie = setCookie.split(";")[0];
    activeCookie = cookie;
    assert.equal((await request("/api/auth/session")).status, 200);
    const initial = await (await request("/api/workspace")).json();
    assert.equal(initial.signedIn, true);
    assert.ok(!JSON.stringify(initial).includes("APP_SESSION_SECRET"));
    for (const route of [
      "meetings",
      "discussions",
      "actions",
      "integrations",
      "profile",
      "settings",
    ])
      assert.equal((await request(`/workspace/${route}`)).status, 200, route);
    const legacyCollection = await request("/workspace/decisions?filter=done");
    assert.equal(legacyCollection.status, 307);
    assert.equal(new URL(legacyCollection.headers.get("location"), origin).pathname, "/workspace/discussions");
    assert.equal(new URL(legacyCollection.headers.get("location"), origin).search, "?filter=done");
    const legacyTab = await request("/workspace/meetings/older-meeting?tab=decisions&segment=s3");
    assert.equal(legacyTab.status, 307);
    const redirected = new URL(legacyTab.headers.get("location"), origin);
    assert.equal(redirected.pathname, "/workspace/meetings/older-meeting");
    assert.equal(redirected.searchParams.get("tab"), "discussions");
    assert.equal(redirected.searchParams.get("segment"), "s3");
    const saved = await request("/api/preferences", "PUT", {
      ...initial.preferences,
      displayName: "Profile test",
      workspaceName: "Workspace test",
      meetingSort: "alphabetical",
    });
    assert.equal(saved.status, 200);
    const prefs = (await saved.json()).preferences;
    assert.equal(
      (
        await request("/api/preferences", "PUT", {
          ...initial.preferences,
          displayName: "stale edit",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request("/api/preferences", "PUT", {
          ...prefs,
          email: "bad-email",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request("/api/preferences", "PUT", prefs, {
          Origin: "https://untrusted.test",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request("/api/integrations/slack", "POST", {
          action: "save",
          updatedAt: initial.integrationStates.slack.updatedAt,
          config: { webhookUrl: "https://evil.test/services/test" },
        })
      ).status,
      400,
    );
    const webhook =
      "https://hooks.slack.com/services/T_TRACE/B_TRACE/TEST_ONLY_FIXTURE";
    const connection = await request("/api/integrations/slack", "POST", {
      action: "save",
      updatedAt: initial.integrationStates.slack.updatedAt,
      config: { webhookUrl: webhook },
    });
    assert.equal(connection.status, 200, await connection.clone().text());
    const publicState = await connection.json();
    assert.equal(publicState.state.configured, true);
    assert.equal(publicState.state.verified, false);
    assert.ok(!JSON.stringify(publicState).includes("TEST_ONLY_FIXTURE"));
    const row = db
      .prepare(
        "SELECT data FROM integration_settings WHERE owner=? AND destination=?",
      )
      .get("local_seedy", "slack");
    assert.ok(!row.data.includes("TEST_ONLY_FIXTURE"));
    assert.ok(!row.data.includes("hooks.slack.com"));
    assert.equal(
      (await request("/api/integrations/slack?updatedAt=" + encodeURIComponent(publicState.state.updatedAt), "DELETE")).status,
      200,
    );
    const disconnected = await (await request("/api/workspace")).json();
    assert.equal(disconnected.integrations.slack, false);
    assert.equal(disconnected.preferences.displayName, "Profile test");
    await request("/api/auth/logout", "POST");
    assert.equal((await request("/api/auth/session")).status, 401);
    cookie = activeCookie;
    assert.equal(
      (await request("/api/workspace")).status,
      401,
      "logout revokes even a copied cookie",
    );
    const legacy = await request("/?meeting=sample-api-v2&segment=s3");
    assert.equal(legacy.status, 307);
    assert.match(
      legacy.headers.get("location"),
      /\/workspace\/meetings\/sample-api-v2\?segment=s3/,
    );
  } finally {
    db.prepare("DELETE FROM preferences WHERE owner=?").run("local_seedy");
    if (originalPrefs)
      db.prepare(
        "INSERT INTO preferences(owner,data,revision) VALUES(?,?,?)",
      ).run(originalPrefs.owner, originalPrefs.data, originalPrefs.revision);
    db.prepare(
      "DELETE FROM integration_settings WHERE owner=? AND destination=?",
    ).run("local_seedy", "slack");
    if (originalSlack)
      db.prepare(
        "INSERT INTO integration_settings(id,owner,destination,data,updated_at) VALUES(?,?,?,?,?)",
      ).run(
        originalSlack.id,
        originalSlack.owner,
        originalSlack.destination,
        originalSlack.data,
        originalSlack.updated_at,
      );
    db.prepare("DELETE FROM login_limits WHERE id=?").run(
      JSON.stringify(["local", "bootstrap"]),
    );
    db.close();
  }
});

test("concurrent login failures cannot bypass the ten-attempt window", async () => {
  const db = new DatabaseSync(dbPath);
  cookie = "";
  try {
    db.prepare("DELETE FROM login_limits WHERE id=?").run(
      JSON.stringify(["local", "bootstrap"]),
    );
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        request("/api/auth/login", "POST", {
          password: "concurrent-wrong-password",
        }),
      ),
    );
    assert.equal(responses.filter((r) => r.status === 401).length, 10);
    assert.equal(responses.filter((r) => r.status === 429).length, 2);
    const blocked = await request("/api/auth/login", "POST", { password });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get("retry-after"), "60");
  } finally {
    db.prepare("DELETE FROM login_limits WHERE id=?").run(
      JSON.stringify(["local", "bootstrap"]),
    );
    db.close();
  }
});
