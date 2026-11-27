import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { extractLinearFollowups } from "../lib/linear-followups.ts";
import { parseTranscript, extractRules, extract } from "../lib/extract.ts";
import { meetingSchema, adrMarkdown, literalMarkdown } from "../lib/types.ts";
import { sampleMeetings } from "./meeting-fixtures.ts";
import {
  CLAIM_SQL,
  AUTHORIZED_CLAIM_SQL,
  planDeliveries,
  preflight,
  deliver,
} from "../lib/publish.ts";

const m = structuredClone(sampleMeetings[0]);
test("imports MeetStream wire fields without losing speaker or evidence timestamps", () => {
  const s = parseTranscript(
    JSON.stringify({
      transcript: [
        {
          speaker: "Sarah Chen",
          start_time: 74.5,
          end_time: 80,
          transcript: "We decided to use Redis.",
        },
      ],
    }),
  );
  assert.deepEqual(s, [
    {
      id: "s1",
      speaker: "Sarah Chen",
      start: 74.5,
      end: 80,
      text: "We decided to use Redis.",
    },
  ]);
});
test("imports native MeetStream participant turns and preserves their evidence", () => {
  const segments = parseTranscript(
    JSON.stringify([
      {
        participant: { name: "Trace Reviewer" },
        words: [
          { text: "We decided", start_timestamp: { relative: 30 } },
          {
            text: "to use cursor pagination.",
            end_timestamp: { relative: 46.56 },
          },
        ],
      },
      {
        participant: { name: "Trace Implementer" },
        words: [
          { text: "I will add", start_timestamp: { relative: 93.18 } },
          {
            text: "the cursor parameter.",
            end_timestamp: { relative: 115.12 },
          },
        ],
      },
    ]),
  );
  assert.deepEqual(
    segments.map(({ speaker, start, end }) => ({ speaker, start, end })),
    [
      { speaker: "Trace Reviewer", start: 30, end: 46.56 },
      { speaker: "Trace Implementer", start: 93.18, end: 115.12 },
    ],
  );
  const { discussions, actions } = extractRules(segments);
  assert.equal(discussions[0].title, "Use cursor pagination");
  assert.deepEqual(discussions[0].evidence, ["s1"]);
  assert.equal(actions[0].owner, "Trace Implementer");
  assert.deepEqual(actions[0].evidence, ["s2"]);
});
test("parses speaker turns and multiline content, rejects missing or invalid timestamps", () => {
  const s = parseTranscript(
    "[00:12] Alex: We decided to use cursors.\nKeep the ordering stable.\n[01:05] Sarah: I’ll write the specification.",
  );
  assert.equal(s[0].start, 12);
  assert.equal(s[0].end, 65);
  assert.match(s[0].text, /ordering/);
  for (const bad of [
    "Alex: no timestamp",
    "[00:99] Alex: bad",
    "[]",
    '[{"speaker":"A","transcript":"hi"}]',
  ])
    assert.throws(() => parseTranscript(bad));
});
test("rules extract explicit agreements and commitments, deduplicate repeats, leave deadlines empty", () => {
  const s = parseTranscript(
    "[00:12] Alex: We decided to use cursors.\n[00:25] Alex: We decided to use cursors.\n[01:05] Sarah: I’ll write the specification.\n[01:15] Alex: Should we split the rate limits?",
  );
  const result = extractRules(s);
  assert.equal(result.discussions.length, 1);
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].owner, "Sarah");
  assert.equal(result.actions[0].due, "");
  assert.equal(result.actions[0].approved, false);
  assert.equal(result.questions.length, 1);
});
test("schema rejects fabricated evidence, owners, invalid due dates and duplicate output IDs", () => {
  assert.equal(meetingSchema.safeParse(m).success, true);
  for (const patch of [
    { evidence: ["nonexistent"] },
    { owner: "Unknown person" },
    { due: "2026-02-30" },
    { id: "d1" },
  ]) {
    const bad = structuredClone(m);
    Object.assign(bad.actions[0], patch);
    assert.equal(meetingSchema.safeParse(bad).success, false);
  }
});
test("ADR includes rationale, consequences and exact evidence links", () => {
  const text = adrMarkdown(m, m.discussions[0], "https://trace.test");
  assert.match(text, /## Rationale/);
  assert.match(text, /## Consequences/);
  assert.match(text, /segment=s3/);
  assert.match(text, /03:24/);
  assert.match(
    text.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))),
    /opaque, base64-encoded cursor/,
  );
});
test("Markdown keeps transcript prose literal and preserves generated evidence links", () => {
  assert.equal(
    literalMarkdown("Review [notes]\n  @team"),
    "Review &#91;notes&#93; &#64;team",
  );
  const draft = structuredClone(m);
  const segment = draft.segments.find(
    (entry) => entry.id === draft.discussions[0].evidence[0],
  )!;
  segment.text = "Review [notes] with @team.";
  const output = adrMarkdown(draft, draft.discussions[0], "https://trace.test");
  assert.match(output, /Review &#91;notes&#93; with &#64;team&#46;/);
  assert.match(output, /\]\(<https:\/\/trace\.test\/workspace\/meetings\//);
});
test("delivery claims require live reviewer authority and unchanged integration settings", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const name of [
      "0000_fluffy_black_tom",
      "0001_neat_redwing",
      "0002_flimsy_shiva",
    ])
      db.exec(
        readFileSync(
          new URL(`../drizzle/${name}.sql`, import.meta.url),
          "utf8",
        ),
      );
    db.exec(`INSERT INTO meetings VALUES('meeting','team','fingerprint','{}',1);
      INSERT INTO members VALUES('actor','team','reviewer','dummy','reviewer');
      INSERT INTO sessions VALUES('session','team',unixepoch()+1000,'actor');`);
    const claim = db.prepare(AUTHORIZED_CLAIM_SQL);
    const attempt = (id: string, connection: string | null = null) =>
      claim.run(
        id,
        "team",
        "meeting",
        id,
        "linear",
        "now",
        "team",
        "meeting",
        1,
        "session",
        "team",
        "team",
        "linear",
        connection,
      ).changes;
    assert.equal(attempt("authorized"), 1);
    db.exec(
      "INSERT INTO integration_settings VALUES('config','team','linear','changed','now')",
    );
    assert.equal(attempt("stale-connection"), 0);
    assert.equal(attempt("current-connection", "changed"), 1);
    db.exec("UPDATE members SET role='editor' WHERE id='actor'");
    assert.equal(attempt("removed-role", "changed"), 0);
    db.exec(
      "UPDATE members SET role='reviewer' WHERE id='actor'; DELETE FROM sessions WHERE id='session';",
    );
    assert.equal(attempt("signed-out", "changed"), 0);
  } finally {
    db.close();
  }
});
test("publishing plan includes only approved outputs, once per destination", () => {
  const draft = structuredClone(m);
  assert.equal(planDeliveries(draft, ["linear", "slack"]).length, 0);
  draft.actions[0].approved = true;
  draft.discussions[0].approved = true;
  assert.deepEqual(
    planDeliveries(draft, ["linear", "linear", "notion", "slack"]),
    [
      { itemId: "a1", destination: "linear" },
      { itemId: "d1", destination: "notion" },
      { itemId: "summary", destination: "slack" },
    ],
  );
  assert.throws(() => preflight(draft, ["linear"], {}), /Sample meetings/);
  draft.source = "import";
  assert.throws(() => preflight(draft, ["linear"], {}), /Connect Linear/);
  draft.reviewed = true;
  assert.doesNotThrow(() => preflight(draft, ["linear"], {
    LINEAR_API_KEY: "test", LINEAR_TEAM_ID: "team",
  }));
  assert.doesNotThrow(() =>
    preflight(draft, ["linear"], {
      LINEAR_API_KEY: "test",
      LINEAR_TEAM_ID: "team",
      LINEAR_ASSIGNEES: '{"Sarah Chen":"sarah-id"}',
    }),
  );
});
test("concurrent SQLite delivery claims permit exactly one external attempt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-ledger-"));
  const path = join(dir, "test.sqlite");
  const db = new DatabaseSync(path);
  try {
    db.exec(
      readFileSync(
        new URL("../drizzle/0000_fluffy_black_tom.sql", import.meta.url),
        "utf8",
      ),
    );
    const seed = db.prepare(
      "INSERT INTO meetings(id,owner,fingerprint,data,revision) VALUES(?,?,?,?,?)",
    );
    seed.run("meeting", "owner", "fixture", "{}", 2);
    seed.run("other-meeting", "other-owner", "fixture", "{}", 1);
    assert.equal(
      db
        .prepare(CLAIM_SQL)
        .run(
          "stale",
          "owner",
          "meeting",
          "a1",
          "linear",
          "now",
          "owner",
          "meeting",
          1,
        ).changes,
      0,
    );
    const code = `const {DatabaseSync}=require('node:sqlite');const {workerData,parentPort}=require('node:worker_threads');const d=new DatabaseSync(workerData.path);d.exec('PRAGMA busy_timeout=5000');const r=d.prepare(workerData.sql).run(...workerData.params);parentPort.postMessage(Number(r.changes));d.close();`;
    const attempts = await Promise.all(
      Array.from(
        { length: 12 },
        (_, i) =>
          new Promise<number>((resolve, reject) => {
            const w = new Worker(code, {
              eval: true,
              workerData: {
                path,
                sql: CLAIM_SQL,
                params: [
                  "attempt-" + i,
                  "owner",
                  "meeting",
                  "a1",
                  "linear",
                  new Date().toISOString(),
                  "owner",
                  "meeting",
                  2,
                ],
              },
            });
            w.once("message", resolve);
            w.once("error", reject);
          }),
      ),
    );
    assert.equal(
      attempts.reduce((n, x) => n + x, 0),
      1,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM deliveries").get()!.count,
      1,
    );
    // A different destination or workspace is a different delivery.
    assert.equal(
      db
        .prepare(CLAIM_SQL)
        .run(
          "github",
          "owner",
          "meeting",
          "a1",
          "github",
          "now",
          "owner",
          "meeting",
          2,
        ).changes,
      1,
    );
    assert.equal(
      db
        .prepare(CLAIM_SQL)
        .run(
          "other",
          "other-owner",
          "other-meeting",
          "a1",
          "linear",
          "now",
          "other-owner",
          "other-meeting",
          1,
        ).changes,
      1,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("Linear transport preserves explicit assignment and evidence; GraphQL errors never count as success", async () => {
  const original = globalThis.fetch;
  const draft = structuredClone(m);
  const config = {
    LINEAR_API_KEY: "test-key",
    LINEAR_TEAM_ID: "team",
    LINEAR_ASSIGNEES: '{"Sarah Chen":"sarah-id"}',
  };
  let calls = 0;
  try {
    globalThis.fetch = async (_url, init) => {
      calls++;
      const request = JSON.parse(String(init!.body));
      assert.equal(request.variables.input.assigneeId, "sarah-id");
      assert.match(request.variables.input.description, /segment=s4/);
      assert.match(request.variables.input.description, /05:10 · Sarah Chen/);
      assert.match(request.query, /assignee\{id\}/);
      return Response.json({
        data: {
          issueCreate: {
            success: true,
            issue: {
              url: "https://linear.app/test/issue/T-1",
              assignee: { id: "sarah-id" },
            },
          },
        },
      });
    };
    assert.equal(
      await deliver(draft, "a1", "linear", "https://trace.test", config),
      "https://linear.app/test/issue/T-1",
    );
    globalThis.fetch = async () => {
      calls++;
      return Response.json({ errors: [{ message: "Rejected" }] });
    };
    await assert.rejects(
      () => deliver(draft, "a1", "linear", "https://trace.test", config),
      /did not confirm/,
    );
    for (const assignee of [null, { id: "another-member" }]) {
      globalThis.fetch = async () => {
        calls++;
        return Response.json({
          data: {
            issueCreate: {
              success: true,
              issue: { url: "https://linear.app/test/issue/T-2", assignee },
            },
          },
        });
      };
      await assert.rejects(
        () => deliver(draft, "a1", "linear", "https://trace.test", config),
        /did not confirm the assignee/,
      );
    }
    assert.equal(calls, 4);
  } finally {
    globalThis.fetch = original;
  }
});
test("AI outputs cannot auto-approve drafts or override meeting identity", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      Response.json({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id: "malicious",
              summary: "A summary",
              discussions: [{ ...m.discussions[0], approved: true }],
              actions: [{ ...m.actions[0], approved: true, completed: true }],
              questions: [],
            }),
          },
        ],
      });
    const result = await extract(m.segments, "test-key");
    assert.equal(result.discussions[0].approved, false);
    assert.equal(result.actions[0].approved, false);
    assert.equal(result.actions[0].completed, false);
    assert.equal("id" in result, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("GitHub verifies assignees; Slack links evidence without accepting mention syntax; Notion includes ADR context", async () => {
  const original = globalThis.fetch;
  const draft = structuredClone(m);
  draft.actions[0].approved = true;
  draft.discussions[0].approved = true;
  draft.actions[0].title = "Review <!channel> and <@U123> handling";
  try {
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(String(init!.body));
      assert.match(String(url), /github.com\/repos\/example\/repo\/issues/);
      assert.deepEqual(body.assignees, ["sarah"]);
      return Response.json({
        html_url: "https://github.com/example/repo/issues/1",
        assignees: [{ login: "sarah" }],
      });
    };
    const c = {
      GITHUB_TOKEN: "test",
      GITHUB_REPOSITORY: "example/repo",
      GITHUB_ASSIGNEES: '{"Sarah Chen":"sarah"}',
    };
    assert.match(
      await deliver(draft, "a1", "github", "https://trace.test", c),
      /issues\/1$/,
    );
    globalThis.fetch = async () =>
      Response.json({
        html_url: "https://github.com/example/repo/issues/2",
        assignees: [],
      });
    await assert.rejects(
      () => deliver(draft, "a1", "github", "https://trace.test", c),
      /did not confirm the assignee/,
    );
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      const text = JSON.stringify(body);
      assert.ok(!text.includes("<!channel>"));
      assert.ok(!text.includes("<@U123>"));
      assert.match(text, /&lt;!channel&gt;/);
      assert.match(
        text,
        /<https:\/\/trace.test\/workspace\/meetings\/[^?]+\?segment=s4\|05:10 evidence>/,
      );
      assert.ok(body.blocks.length <= 50);
      return new Response("ok");
    };
    assert.equal(
      await deliver(draft, "summary", "slack", "https://trace.test", {
        SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/test",
      }),
      "",
    );
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      assert.equal(body.parent.page_id, "parent");
      assert.equal(
        body.properties.title.title[0].text.content,
        draft.discussions[0].title,
      );
      assert.match(JSON.stringify(body.children), /## Consequences/);
      return Response.json({ url: "https://notion.so/test-page" });
    };
    assert.equal(
      await deliver(draft, "d1", "notion", "https://trace.test", {
        NOTION_API_KEY: "test",
        NOTION_PARENT_PAGE_ID: "parent",
      }),
      "https://notion.so/test-page",
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("audio corrections use speaker activity and preserve spoken thanks", async () => {
  const { correctTranscript } = await import("../lib/meetstream/transcript-audio.ts");
  const turns = [
    { id: "s1", speaker: "Alex", start: 1, end: 3, text: "Thank you." },
    {
      id: "s2",
      speaker: "Alex",
      start: 5,
      end: 10,
      text: "We decided to use cursors.",
    },
    {
      id: "s3",
      speaker: "Alex",
      start: 12,
      end: 19,
      text: "I will write tests. Thank you.",
    },
    { id: "s4", speaker: "Sam", start: 20, end: 22, text: "Thank you." },
  ];
  const audio = {
    duration: 30,
    windows: [
      { start: 10, end: 11 },
      { start: 12, end: 16 },
      { start: 20, end: 22 },
    ],
  };
  const tails = new Map([["s3", { start: 17, end: 19 }]]);
  const speakers = new Map([
    ["Alex", [{ start: 10.2, end: 16 }]],
    ["Sam", [{ start: 20, end: 22 }]],
  ]);
  const result = correctTranscript(turns, audio, tails, speakers);
  assert.deepEqual(
    result.map((t) => [t.id, t.start, t.text]),
    [
      ["s2", 10, "We decided to use cursors."],
      ["s3", 12, "I will write tests."],
      ["s4", 20, "Thank you."],
    ],
  );
  assert.equal(correctTranscript(turns, audio, tails)[0].start, 5);
  assert.deepEqual(
    correctTranscript(turns, { ...audio, windows: [] }, tails, speakers),
    turns,
  );
});

test("webhook delivery signs the original body and rejects tampered or stale requests", async () => {
  const { verifyWebhook } = await import("../lib/webhook.ts");
  const meeting = structuredClone(m);
  meeting.discussions[0].approved = true;
  const id = crypto.randomUUID();
  const secret = "test-signing-secret-with-more-than-32-characters";
  const oldFetch = globalThis.fetch;
  let deliveries = 0;
  try {
    globalThis.fetch = async (url, init) => {
      deliveries++;
      assert.equal(url, "https://example.test/events");
      assert.equal(init?.redirect, "manual");
      const headers = new Headers(init?.headers);
      const raw = String(init?.body);
      assert.equal(headers.get("X-Trace-Delivery"), id);
      assert.equal(await verifyWebhook(secret, headers, raw), true);
      assert.equal(await verifyWebhook(secret, headers, raw + " "), false);
      assert.equal(
        await verifyWebhook(secret, headers, raw, Date.now() + 301000),
        false,
      );
      assert.equal(
        await verifyWebhook(
          "another-secret-which-is-at-least-32-characters",
          headers,
          raw,
        ),
        false,
      );
      const payload = JSON.parse(raw);
      assert.equal(payload.event, "meeting.reviewed");
      assert.equal(payload.discussions.length, 1);
      assert.deepEqual(payload.actions, []);
      assert.ok(
        payload.evidence.every((s: { id: string }) =>
          meeting.discussions[0].evidence.includes(s.id),
        ),
      );
      return new Response(null, { status: 204 });
    };
    await deliver(
      meeting,
      "summary",
      "webhook",
      "http://localhost:5173",
      {
        TRACE_WEBHOOK_URL: "https://example.test/events",
        TRACE_WEBHOOK_SECRET: secret,
      },
      id,
    );
    assert.equal(deliveries, 1);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("MeetStream uses sentence timestamps supported by recording activity", async () => {
  const { splitTimedSentences } = await import("../lib/meetstream/import.ts");
  const turn = { id: "s1", speaker: "Taylor", start: 24, end: 34,
    text: "Hello Arjun. I will add tests." };
  const words = new Map([[turn.id, [
    { text: "Hello Arjun.", start_timestamp: { relative: 24 } },
    { text: "I will add tests.", start_timestamp: { relative: 29.4 } },
  ]]]);
  const timed = splitTimedSentences([turn], words, [{ start: 29, end: 31 }]);
  assert.deepEqual(timed.map(({ id, start }) => [id, start]), [["s1", 24], ["s1-2", 29.4]]);
  assert.deepEqual(extractRules(timed).actions[0].evidence, ["s1-2"]);
  assert.deepEqual(splitTimedSentences([turn], words, [{ start: 24, end: 27 }]), [turn]);
});

test("recording activity scans a 30-minute WAV and handles split PCM samples", async () => {
  const { recordingActivity } = await import("../lib/meetstream/transcript-audio.ts");
  const rate = 48000;
  const duration = 30 * 60;
  const length = duration * rate * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(length + 36, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(length, 40);
  const silence = new Uint8Array(256 * 1024 + 1);
  const sound = Buffer.alloc(rate * 2);
  for (let i = 0; i < sound.length; i += 2) sound.writeInt16LE(-1000, i);
  let remaining = length - sound.length;
  let sentHeader = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sentHeader) {
        sentHeader = true;
        controller.enqueue(header.subarray(0, 11));
        controller.enqueue(header.subarray(11));
      } else if (remaining > 0) {
        const length = Math.min(remaining, silence.length);
        controller.enqueue(silence.subarray(0, length));
        remaining -= length;
      } else {
        controller.enqueue(sound.subarray(0, 1));
        controller.enqueue(sound.subarray(1));
        controller.close();
      }
    },
  });
  const audio = await recordingActivity(new Response(stream, {
    headers: { "content-length": String(length + header.length) },
  }));
  assert.deepEqual(audio, { duration, windows: [{ start: duration - 1, end: duration }] });
});


test("unmapped and unassigned owners never block issue creation", async () => {
  const originalFetch = globalThis.fetch;
  const meeting = structuredClone(m);
  meeting.source = "import";
  meeting.reviewed = false;
  meeting.actions[0].approved = true;
  const config = {
    LINEAR_API_KEY: "fixture", LINEAR_TEAM_ID: "team", LINEAR_ASSIGNEES: "{}",
    GITHUB_TOKEN: "fixture", GITHUB_REPOSITORY: "example/repo", GITHUB_ASSIGNEES: "{}",
  };
  try {
    for (const owner of ["Unmapped Participant", ""]) {
      meeting.actions[0].owner = owner;
      preflight(meeting, ["linear", "github"], config);
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.variables) {
          assert.equal("assigneeId" in body.variables.input, false);
          return Response.json({ data: { issueCreate: {
            success: true, issue: { url: "https://linear.app/example/issue/T-1", assignee: null },
          } } });
        }
        assert.equal("assignees" in body, false);
        return Response.json({ html_url: "https://github.com/example/repo/issues/1", assignees: [] });
      };
      await deliver(meeting, meeting.actions[0].id, "linear", "http://localhost:5173", config);
      await deliver(meeting, meeting.actions[0].id, "github", "http://localhost:5173", config);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rules separate settled choices, suggestions, and concrete commitments", () => {
  const turns = parseTranscript([
    "[00:01] Alex: Let's use Redis.",
    "[00:02] Alex: Should we use Redis?",
    "[00:03] Alex: We're going with Postgres.",
    "[00:04] Alex: We settled on Postgres.",
    "[00:05] Alex: I'll tell you.",
    "[00:06] Alex: I'm going to write a load test.",
    "[00:07] Robin: I will write a load test.",
    "[00:08] Robin: I will not deploy today.",
  ].join("\n"));
  const { discussions, actions, questions } = extractRules(turns);
  assert.deepEqual(discussions.map((item) => [item.title, item.evidence]), [["Postgres", ["s3"]]]);
  assert.deepEqual(actions.map((item) => item.owner), ["Alex", "Robin"]);
  assert.deepEqual(questions, ["Should we use Redis?"]);
});

test("Linear follow-ups require clear context and preserve the evidence behind a pronoun", () => {
  const history = [{
    id: "0d20822a-1a1e-4caf-8d2c-b7e9238842d4", title: "Add cursor pagination to the audit log",
    project: "Audit", url: "https://linear.app/trace/issue/ENG-314/audit-log",
  }];
  const input = parseTranscript([
    "[00:01] Alex: Regarding cursor pagination for the audit log.",
    "[00:03] Alex: I'm working on it.",
    "[00:07] Robin: It is done.",
    "[00:12] Alex: Is cursor pagination for the audit log done?",
  ].join("\n"));
  const [matched] = extractLinearFollowups([], input, "Audit", history);
  assert.equal(matched.linearFollowup?.kind, "issue");
  if (matched.linearFollowup?.kind !== "issue") assert.fail("Expected a matched issue");
  assert.equal(matched.linearFollowup.status, "started");
  assert.deepEqual(matched.evidence, ["s1", "s2"]);
  assert.deepEqual(extractLinearFollowups([], input, "Another project", history), []);
  assert.deepEqual(extractLinearFollowups([], parseTranscript("[00:02] Alex: I'm working on it."), "Audit", history), []);
  const [ambiguous] = extractLinearFollowups([], parseTranscript(
    "[00:02] Alex: Cursor pagination for the audit log is done.",
  ), "Audit", [...history, {
    ...history[0], id: "cfca1938-5568-406c-a528-51af57a85538",
    url: "https://linear.app/trace/issue/ENG-315",
  }]);
  assert.equal(ambiguous.linearFollowup?.kind, "ambiguous");
});
