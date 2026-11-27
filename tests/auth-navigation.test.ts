import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSession,
  verifySession,
  passwordMatches,
  safeReturnTo,
  sessionCookie,
} from "../lib/auth.ts";
import {
  workspaceRoute,
  meetingPath,
  canonicalWorkspacePath,
} from "../lib/navigation.ts";
import { sortMeetings, sortOutputs } from "../lib/sorting.ts";
import { sampleMeetings } from "./meeting-fixtures.ts";
import { linearOptions, githubOptions } from "../lib/integration-provider.ts";
const secret = "a-test-secret-with-at-least-thirty-two-characters";
test("encoded meeting params survive a login return URL exactly once", () => {
  const expected = meetingPath("local_seedy:sample-api-v2");
  assert.equal(
    canonicalWorkspacePath(["meetings", "local_seedy%3Asample-api-v2"]),
    expected,
  );
  assert.equal(
    canonicalWorkspacePath(["meetings", "local_seedy:sample-api-v2"]),
    expected,
  );
});
test("application sessions reject tampering, expiry, secret rotation and password changes", async () => {
  const now = 1700000000000;
  const { token, session } = await createSession(secret, "6969", now);
  assert.deepEqual(await verifySession(token, secret, "6969", now), session);
  assert.equal(await verifySession(token + "x", secret, "6969", now), null);
  assert.equal(await verifySession(token, secret, "changed", now), null);
  assert.equal(await verifySession(token, "changed-secret", "6969", now), null);
  assert.equal(
    await verifySession(token, secret, "6969", now + 8 * 86400000),
    null,
  );
  assert.equal(await verifySession("bad.token", secret, "6969", now), null);
  assert.equal(await passwordMatches("6969", "6969"), true);
  assert.equal(await passwordMatches("6968", "6969"), false);
  assert.match(
    sessionCookie(token, true),
    /HttpOnly; SameSite=Lax; Max-Age=604800; Secure$/,
  );
  assert.match(sessionCookie("", false, true), /Max-Age=0$/);
});
test("return paths and canonical routes stay inside the workspace", () => {
  assert.equal(safeReturnTo("https://evil.test"), "/workspace/meetings");
  assert.equal(safeReturnTo("//evil.test"), "/workspace/meetings");
  assert.equal(safeReturnTo("/workspace\\evil.test"), "/workspace/meetings");
  assert.equal(safeReturnTo("/workspace/profile"), "/workspace/profile");
  assert.deepEqual(
    workspaceRoute("/workspace/meetings/local_seedy%3Asample-api-v2"),
    { view: "meetings", meetingId: "local_seedy:sample-api-v2" },
  );
  assert.equal(workspaceRoute("/workspace/profile/extra"), null);
  assert.equal(workspaceRoute("/workspace/unknown"), null);
  assert.equal(
    meetingPath("id/with slash"),
    "/workspace/meetings/id%2Fwith%20slash",
  );
});
test("meeting and action sorting is deterministic and leaves the stored data intact", () => {
  const before = sampleMeetings.map((m) => m.id);
  assert.equal(sortMeetings(sampleMeetings, "newest")[0].id, "sample-api-v2");
  assert.equal(sortMeetings(sampleMeetings, "review")[0].reviewed, false);
  const oldest = sortMeetings(sampleMeetings, "oldest");
  assert.ok(oldest[0].date <= oldest.at(-1)!.date);
  const rows = sampleMeetings[0].actions.map((item) => ({
    meeting: sampleMeetings[0],
    item,
  }));
  assert.equal(sortOutputs(rows, "priority")[0].item.priority, "High");
  assert.deepEqual(
    sampleMeetings.map((m) => m.id),
    before,
  );
});
test("Linear setup reads teams and members, and checks GraphQL errors", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "https://api.linear.app/graphql");
      assert.equal(init?.redirect, "manual");
      const body = JSON.parse(String(init!.body));
      assert.match(body.query, /query TraceConnect/);
      assert.ok(!body.query.includes("mutation"));
      return Response.json({
        data: {
          viewer: { name: "Test User" },
          teams: { nodes: [{ id: "team", name: "Platform" }] },
          users: {
            nodes: [{ id: "sarah", name: "Sarah Chen" }],
            pageInfo: { hasNextPage: false },
          },
        },
      });
    };
    const result = await linearOptions({ token: "test" });
    assert.equal(result.teams[0].id, "team");
    assert.equal(result.users[0].name, "Sarah Chen");
    globalThis.fetch = async () =>
      Response.json({ errors: [{ message: "denied" }] });
    await assert.rejects(() => linearOptions({ token: "test" }), /permissions/);
  } finally {
    globalThis.fetch = original;
  }
});
test("GitHub setup reads repository, identity and assignable users without writing", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  try {
    globalThis.fetch = async (url, init) => {
      calls.push(String(url));
      assert.ok(!init?.method || init.method === "GET");
      assert.equal(init?.redirect, "manual");
      if (String(url).includes("/assignees"))
        return Response.json([{ login: "sarah" }]);
      if (String(url).endsWith("/user"))
        return Response.json({ login: "sarah", name: "Sarah Chen" });
      return Response.json({ full_name: "test/repo", has_issues: true });
    };
    const result = await githubOptions({
      token: "test",
      repository: "test/repo",
    });
    assert.equal(result.users[0].id, "sarah");
    assert.equal(calls.length, 3);
    await assert.rejects(
      () => githubOptions({ token: "test", repository: "../invalid" }),
      /owner\/name/,
    );
    globalThis.fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://another.example" },
      });
    await assert.rejects(
      () => githubOptions({ token: "test", repository: "test/repo" }),
      /HTTP 302/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
