import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { globSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

test("named accounts isolate workspace data and credentials, enforce review roles, and audit writes", async () => {
  const base = new URL(process.env.TRACE_TEST_URL || "http://127.0.0.1:5173");
  assert.ok(["127.0.0.1", "localhost"].includes(base.hostname));
  const workspace = "test-" + randomUUID();
  const password = randomBytes(24).toString("hex");
  const cookies = [];
  async function request(path, method, data, cookie) {
    return fetch(new URL(path, base), {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  }
  async function login(data) {
    const result = await request("/api/auth/login", "POST", data);
    assert.equal(result.status, 200, await result.clone().text());
    const cookie = result.headers.get("set-cookie").split(";")[0];
    cookies.push(cookie);
    return cookie;
  }
  const fixture = {
    title: "Role test",
    transcript:
      "[00:01] Alex: We decided to use cursors.\n[00:03] Alex: I will write the test.",
    project: "Test project",
    date: new Date().toISOString(),
    useAI: false,
  };
  let foreignFixtureId;
  try {
    const bootstrap = await login({
      password: parseEnv(readFileSync(".env", "utf8")).APP_PASSWORD,
    });
    const setup = await request(
      "/api/admin",
      "POST",
      {
        action: "workspace",
        id: workspace,
        name: "Isolation test",
        username: "admin",
        password,
      },
      bootstrap,
    );
    assert.equal(setup.status, 200, await setup.clone().text());
    const admin = await login({ workspace, username: "admin", password });
    const initial = await (
      await request("/api/workspace", "GET", null, admin)
    ).json();
    assert.equal(initial.access.workspace, workspace);
    assert.deepEqual(initial.meetings, []);
    assert.ok(
      Object.values(initial.integrations).every((value) => value === false),
    );
    const foreignResponse = await request(
      "/api/meetings",
      "POST",
      {
        ...fixture,
        title: "Private fixture",
        project: "Private project",
        transcript:
          "[00:01] Alex: We decided to keep this in the original workspace.",
      },
      bootstrap,
    );
    assert.equal(
      foreignResponse.status,
      201,
      await foreignResponse.clone().text(),
    );
    const { meeting: foreign } = await foreignResponse.json();
    foreignFixtureId = foreign.id;
    assert.equal(
      (
        await request(
          "/api/meetings/" + encodeURIComponent(foreign.id),
          "PUT",
          foreign,
          admin,
        )
      ).status,
      404,
    );
    const duplicate = await request(
      "/api/admin",
      "POST",
      {
        action: "workspace",
        id: workspace,
        name: "Collision",
        username: "other",
        password,
      },
      bootstrap,
    );
    assert.equal(duplicate.status, 409);
    for (const role of ["editor", "reviewer", "viewer"]) {
      const result = await request(
        "/api/admin",
        "POST",
        { action: "member", username: role, role, password },
        admin,
      );
      assert.equal(result.status, 200, await result.clone().text());
    }
    const editor = await login({ workspace, username: "editor", password });
    const reviewer = await login({ workspace, username: "reviewer", password });
    const viewer = await login({ workspace, username: "viewer", password });
    assert.equal(
      (await request("/api/admin", "GET", null, editor)).status,
      403,
    );
    assert.equal(
      (await request("/api/integrations/linear", "DELETE", null, reviewer))
        .status,
      403,
    );
    assert.equal(
      (await request("/api/meetings", "POST", fixture, viewer)).status,
      403,
    );
    const created = await request("/api/meetings", "POST", fixture, editor);
    assert.equal(created.status, 201, await created.clone().text());
    const { meeting } = await created.json();
    const update = {
      ...meeting,
      reviewed: true,
      discussions: meeting.discussions.map((d) => ({ ...d, approved: true })),
    };
    assert.equal(
      (await request("/api/meetings/" + meeting.id, "PUT", update, editor))
        .status,
      403,
    );
    const approved = await request(
      "/api/meetings/" + meeting.id,
      "PUT",
      update,
      reviewer,
    );
    assert.equal(approved.status, 200, await approved.clone().text());
    assert.equal(
      (
        await request(
          "/api/publish",
          "POST",
          { meetingId: meeting.id, revision: 1, destinations: ["webhook"] },
          editor,
        )
      ).status,
      403,
    );
    const { meeting: reviewed } = await approved.json();
    assert.equal(reviewed.actions[0].approved, false);
    const completed = await request(
      "/api/meetings/" + meeting.id,
      "PUT",
      {
        ...reviewed,
        actions: reviewed.actions.map((item) => ({ ...item, completed: true })),
      },
      editor,
    );
    assert.equal(completed.status, 200, await completed.clone().text());
    const { meeting: tracked } = await completed.json();
    assert.equal(tracked.reviewed, true);
    assert.equal(tracked.actions[0].completed, true);
    assert.equal(tracked.actions[0].approved, false);
    const project = { name: fixture.project };
    assert.equal(
      (await request("/api/projects", "DELETE", project, reviewer)).status,
      403,
    );
    assert.equal(
      (await request("/api/projects", "DELETE", project, bootstrap)).status,
      404,
    );
    assert.equal(
      (await request("/api/projects", "DELETE", project, admin)).status,
      200,
    );
    const {
      meetings: [unassigned],
    } = await (await request("/api/workspace", "GET", null, admin)).json();
    assert.equal(unassigned.id, meeting.id);
    assert.equal(unassigned.project, "");
    assert.equal(unassigned.revision, meeting.revision + 3);
    assert.equal(unassigned.segments, undefined);
    assert.deepEqual(unassigned.turns, meeting.segments.map(({ id, speaker, start }) => ({ id, speaker, start })));
    const detail = await request("/api/meetings/" + meeting.id, "GET", null, viewer);
    assert.equal(detail.status, 200);
    assert.deepEqual((await detail.json()).meeting.segments, meeting.segments);
    assert.equal((await request("/api/meetings/" + foreign.id, "GET", null, viewer)).status, 404);
    assert.equal((await request("/api/meetings/" + meeting.id, "GET")).status, 401);
    const audit = await (
      await request("/api/admin", "GET", null, admin)
    ).json();
    assert.equal(
      audit.events.filter(
        (event) =>
          event.action === "meeting.review_changed" &&
          event.target === meeting.id,
      ).length,
      1,
    );
    const correctionPath = "/api/meetings/" + meeting.id;
    const add = { kind: "discussion", title: "Use a cursor for the audit log", segmentId: "s2", revision: unassigned.revision };
    assert.equal((await request(correctionPath, "POST", add, editor)).status, 403);
    assert.equal((await request(correctionPath, "POST", add, viewer)).status, 403);
    assert.equal((await request("/api/meetings/" + foreign.id, "POST", add, reviewer)).status, 404);
    assert.equal((await request(correctionPath, "POST", { ...add, segmentId: "missing" }, reviewer)).status, 404);
    const addedResponse = await request(correctionPath, "POST", add, reviewer);
    assert.equal(addedResponse.status, 200, await addedResponse.clone().text());
    const { meeting: added } = await addedResponse.json();
    assert.equal(added.reviewed, false);
    assert.deepEqual(added.discussions[1].evidence, ["s2"]);
    assert.equal((await request(correctionPath, "POST", add, reviewer)).status, 409);
    const merge = { kind: "merge", keepId: added.discussions[0].id, removeId: added.discussions[1].id, revision: added.revision };
    const dbFile = globSync(".wrangler/state/v3/d1/**/*.sqlite").find((path) => !path.endsWith("metadata.sqlite"));
    const database = new DatabaseSync(dbFile);
    try {
      database.prepare(
        "INSERT INTO deliveries (id,owner,meeting_id,item_id,destination,status,created_at) VALUES (?,?,?,?,?,?,?)",
      ).run(randomUUID(), workspace, meeting.id, merge.keepId, "linear", "pending", new Date().toISOString());
      const locked = await request(correctionPath, "POST", merge, reviewer);
      assert.equal(locked.status, 409);
      assert.match((await locked.json()).error, /publishing activity/i);
    } finally {
      database.prepare("DELETE FROM deliveries WHERE owner=?").run(workspace);
      database.close();
    }
    const mergedResponse = await request(correctionPath, "POST", merge, reviewer);
    assert.equal(mergedResponse.status, 200, await mergedResponse.clone().text());
    const { meeting: merged } = await mergedResponse.json();
    assert.deepEqual(merged.discussions.map(({ id, evidence, approved }) => ({ id, evidence, approved })), [
      { id: merge.keepId, evidence: ["s1", "s2"], approved: false },
    ]);
    let corrected = merged;
    for (const [segmentId, speaker] of [["s1", "Robin"], ["s2", "Taylor"]]) {
      const response = await request(correctionPath, "POST", {
        kind: "speaker", segmentId, speaker, revision: corrected.revision,
      }, reviewer);
      assert.equal(response.status, 200, await response.clone().text());
      corrected = (await response.json()).meeting;
    }
    assert.deepEqual(corrected.segments.map(({ speaker }) => speaker), ["Robin", "Taylor"]);
    assert.deepEqual(corrected.segments.map(({ id, text, start, end }) => ({ id, text, start, end })), meeting.segments.map(({ id, text, start, end }) => ({ id, text, start, end })));
    assert.equal(corrected.actions[0].owner, "Alex");
    const actionResponse = await request(correctionPath, "POST", {
      kind: "action", segmentId: "s2", title: "Add a cursor test", owner: "Taylor", revision: corrected.revision,
    }, reviewer);
    assert.equal(actionResponse.status, 200, await actionResponse.clone().text());
    const { meeting: actionAdded } = await actionResponse.json();
    assert.equal(actionAdded.actions[1].owner, "Taylor");
    const renamedAgain = await request(correctionPath, "POST", {
      kind: "speaker", segmentId: "s2", speaker: "Jamie", revision: actionAdded.revision,
    }, reviewer);
    assert.equal(renamedAgain.status, 200, await renamedAgain.clone().text());
    const { meeting: final } = await renamedAgain.json();
    assert.equal(final.actions[1].owner, "Taylor");
    const mergedAction = await request(correctionPath, "POST", {
      kind: "merge", keepId: final.actions[1].id, removeId: final.actions[0].id, revision: final.revision,
    }, reviewer);
    assert.equal(mergedAction.status, 200, await mergedAction.clone().text());
    const { meeting: mergedActions } = await mergedAction.json();
    assert.deepEqual(mergedActions.actions.map(({ owner, evidence }) => ({ owner, evidence })), [
      { owner: "Taylor", evidence: ["s2"] },
    ]);
    assert.equal((await request(correctionPath, "PUT", mergedActions, reviewer)).status, 200);
    const correctionAudit = await (await request("/api/admin", "GET", null, admin)).json();
    assert.ok(correctionAudit.events.some((event) => event.action === "meeting.corrected:merge" && event.target === meeting.id));
    const member = audit.members.find((m) => m.role === "viewer");
    assert.equal(
      (
        await request(
          "/api/admin",
          "POST",
          { action: "remove", id: member.id },
          admin,
        )
      ).status,
      200,
    );
    assert.equal(
      (await request("/api/workspace", "GET", null, viewer)).status,
      401,
    );
  } finally {
    for (const cookie of cookies)
      await request("/api/auth/logout", "POST", {}, cookie);
    const file = globSync(".wrangler/state/v3/d1/**/*.sqlite").find(
      (p) => !p.endsWith("metadata.sqlite"),
    );
    const db = new DatabaseSync(file);
    try {
      if (foreignFixtureId) {
        db.prepare("DELETE FROM meetings WHERE owner=? AND id=?").run(
          "local_seedy",
          foreignFixtureId,
        );
        db.prepare("DELETE FROM audit_log WHERE workspace=? AND target=?").run(
          "local_seedy",
          foreignFixtureId,
        );
      }
      for (const [table, column] of [
        ["meetings", "owner"],
        ["members", "workspace"],
        ["audit_log", "workspace"],
        ["workspaces", "id"],
      ])
        db.prepare(`DELETE FROM ${table} WHERE ${column}=?`).run(workspace);
    } finally {
      db.close();
    }
  }
});
