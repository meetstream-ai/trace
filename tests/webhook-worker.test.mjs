import assert from "node:assert/strict";
import { cpSync, globSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { verifyWebhook } from "../lib/webhook.ts";

test(
  "private workspace and signed delivery survive isolated D1 backup and restore",
  { timeout: 15000 },
  async () => {
    const root = resolve("dist/server");
    const deployed = JSON.parse(
      readFileSync(join(root, "wrangler.json"), "utf8"),
    );
    const assetRoot = resolve(root, deployed.assets.directory);
    const script = globSync("_next/static/**/*.js", { cwd: assetRoot })[0];
    const migrations = globSync("drizzle/*.sql")
      .sort()
      .flatMap((path) =>
        readFileSync(path, "utf8").split("--> statement-breakpoint"),
      )
      .map((sql) => sql.trim())
      .filter(Boolean);
    const endpoint = "https://trace-test.example/events";
    const bootstrapPassword = "fixture-bootstrap";
    const adminPassword = "fixture-admin-password";
    const signingSecret = "fixture-webhook-secret-more-than-32-characters";
    const sessionSecret = "fixture-session-secret-more-than-32-characters";
    const liveToken = "fixture_live_token_at_least_32_chars";
    const credentials = [
      bootstrapPassword, adminPassword, signingSecret, sessionSecret, liveToken,
      "fixture-meetstream-token", "fixture-linear-token", "fixture-github-token",
      "fixture-jira-token", "fixturekey", "fixturetoken",
      process.env.VITE_TRACE_TEST_CREDENTIAL,
    ].filter(Boolean);
    function assertNoCredentials(body) {
      for (const credential of credentials) {
        assert.equal(body.includes(credential), false, "Credential leaked into a browser response or asset");
      }
    }
    for (const path of globSync("**/*.{js,css,html,map}", { cwd: assetRoot })) {
      assertNoCredentials(readFileSync(resolve(assetRoot, path), "utf8"));
    }
    const received = [];
    const botRequests = new Set();
    const fixtureBotId = "fixture-meetstream-bot";
    const secondBotId = "second-meetstream-bot";
    let botStatus = "InMeeting";
    let transcriptReady = false;
    let botStopRequests = 0;
    const fixtureAudio = Buffer.alloc(204);
    fixtureAudio.write("RIFF");
    fixtureAudio.writeUInt32LE(196, 4);
    fixtureAudio.write("WAVEfmt ", 8);
    fixtureAudio.writeUInt32LE(16, 16);
    fixtureAudio.writeUInt16LE(1, 20);
    fixtureAudio.writeUInt16LE(1, 22);
    fixtureAudio.writeUInt32LE(8000, 24);
    fixtureAudio.writeUInt32LE(16000, 28);
    fixtureAudio.writeUInt16LE(2, 32);
    fixtureAudio.writeUInt16LE(16, 34);
    fixtureAudio.write("data", 36);
    fixtureAudio.writeUInt32LE(160, 40);
    const issues = [];
    let afterIssue;
    let beforeProjectRead;
    const issueFailures = new Map();
    const linearIssues = new Map();
    const followupStatusRequests = [];
    let trackedLinearIssue;
    let timeoutAfterStatus = false;
    const tls = process.env.TRACE_TEST_TLS_DIR;
    const state = mkdtempSync(join(tmpdir(), "trace-recovery-"));
    const primary = join(state, "primary");
    const backup = join(state, "backup");
    const recovered = join(state, "recovered");
    const canonical = tls ? "https://127.0.0.1:18443" : "";
    function launch(storage, paused = false) {
      const config = convertV4MiniflareOptions({
        host: "127.0.0.1",
        ...(tls
          ? {
              port: 18443,
              https: true,
              httpsKey: readFileSync(join(tls, "tls-key.pem"), "utf8"),
              httpsCert: readFileSync(join(tls, "tls-cert.pem"), "utf8"),
            }
          : {}),
        modulesRoot: root,
        modules: [
          {
            type: "ESModule",
            path: resolve(root, "test-entry.mjs"),
            contents: `
          import app from "./index.js";
          export default {
            async fetch(request, env, ctx) {
              if (new URL(request.url).pathname === "/test-init") {
                await env.DB.batch(${JSON.stringify(migrations)}.map(sql => env.DB.prepare(sql)));
                return new Response(null, { status: 204 });
              }
              return app.fetch(request, env, ctx);
            }
          };
        `,
          },
          ...globSync("**/*.js", { cwd: root }).map((path) => ({
            type: "ESModule",
            path: resolve(root, path),
          })),
        ],
        compatibilityDate: deployed.compatibility_date,
        compatibilityFlags: deployed.compatibility_flags,

        d1Databases: ["DB"],
        bindings: {
          APP_PASSWORD: bootstrapPassword,
          TRACE_LOCAL_BOOTSTRAP: "1",
          TRACE_PUBLIC_ORIGIN: canonical,
          TRACE_PAUSE_PUBLISHING: paused ? "1" : "",
          MEETSTREAM_API_KEY: "fixture-meetstream-token",
          TRACE_MEETING_AGENT_ORIGIN: "https://agent.example.test",
          TRACE_MEETING_AGENT_ID: "incident",
          TRACE_MEETING_AGENT_LIVE_TOKEN: liveToken,
          GITHUB_TOKEN: "fixture-github-token",
          GITHUB_REPOSITORY: "example/project",
          GITHUB_ASSIGNEES: '{"Alex":"alex"}',
          LINEAR_API_KEY: "fixture-linear-token",
          LINEAR_TEAM_ID: "fixture-team",
          LINEAR_ASSIGNEES: '{"Alex":"alex"}',
          APP_SESSION_SECRET: sessionSecret,
          TRACE_WEBHOOK_ENDPOINTS: JSON.stringify({ local_seedy: [endpoint] }),
        },
        async outboundService(request) {
          const target = new URL(request.url);
          if (target.hostname === "api.meetstream.ai") {
            assert.equal(
              request.headers.get("authorization"),
              "Token fixture-meetstream-token",
            );
            if (target.pathname === "/api/v1/bots/create_bot") {
              const input = await request.json();
              assert.equal(request.method, "POST");
              assert.ok([
                "https://meet.google.com/abc-defg-hij",
                "https://meet.google.com/abc-defg-xyz",
              ].includes(input.meeting_link));
              assert.equal(input.audio_required, true);
              if (input.meeting_link.endsWith("xyz")) {
                assert.equal(input.bot_name, "Engineering Notes");
                assert.equal(input.video_required, true);
                assert.deepEqual(input.recording_config, {
                  transcript: { provider: {
                    assemblyai: { language_code: "en_us", speech_models: ["universal-2"] },
                    meetstream_streaming: { transcription_mode: "sentence" },
                  } },
                  video_layout: "grid_view",
                });
                assert.deepEqual(input.custom_attributes, { trace_agent: "incident" });
                assert.deepEqual(input.live_transcription_required, {
                  webhook_url: `https://agent.example.test/webhooks/live/${liveToken}`,
                });
              } else {
                assert.equal(input.bot_name, "Trace Notetaker");
                assert.equal(input.video_required, false);
                assert.equal(input.live_transcription_required, undefined);
                assert.deepEqual(input.recording_config, { transcript: { provider: { meetstream: {} } } });
              }
              const key = request.headers.get("idempotency-key");
              assert.ok(key);
              const repeat = botRequests.has(key);
              botRequests.add(key);
              return Response.json(
                { bot_id: input.meeting_link.endsWith("xyz") ? secondBotId : fixtureBotId },
                { status: repeat ? 507 : 201 },
              );
            }
            if (target.pathname === `/api/v1/bots/${fixtureBotId}/get_audio`)
              return Response.json({ audio_url: "https://fixture.s3.amazonaws.com/recording.wav" });
            if (target.pathname === `/api/v1/bots/${fixtureBotId}/status`)
              return Response.json({ status: botStatus });
            if (target.pathname === `/api/v1/bots/${secondBotId}/status`)
              return Response.json({ status: "InWaitingRoom" });
            if (target.pathname === `/api/v1/bots/${fixtureBotId}/remove_bot`) {
              assert.equal(request.method, "POST");
              botStopRequests++;
              return Response.json(
                { status: "graceful_exit_in_progress" },
                { status: 202 },
              );
            }
            if (
              target.pathname === `/api/v1/bots/${fixtureBotId}/get_transcript`
            )
              return transcriptReady
                ? Response.json([
                    {
                      speaker: "Alex",
                      transcript: "We decided to use cursors.",
                      start_time: 1,
                      end_time: 2,
                    },
                    {
                      speaker: "Alex",
                      transcript: "I will write the test.",
                      start_time: 3,
                      end_time: 5,
                    },
                  ])
                : Response.json({}, { status: 202 });
            return new Response(null, { status: 404 });
          }
          if (target.hostname === "fixture.s3.amazonaws.com") {
            assert.equal(request.headers.has("Authorization"), false);
            if (request.headers.has("Range")) {
              assert.equal(request.headers.get("Range"), "bytes=44-63");
              return new Response(fixtureAudio.subarray(44, 64), {
                status: 206,
                headers: { "Content-Range": "bytes 44-63/204", "Content-Length": "20" },
              });
            }
            return new Response(fixtureAudio);
          }

          if (
            target.hostname === "api.github.com" &&
            target.pathname.endsWith("/issues")
          ) {
            if (request.method === "GET") {
              assert.equal(target.searchParams.get("state"), "all");
              return Response.json(issues.map((issue, index) => ({
                body: issue.body,
                html_url: "https://github.com/example/project/issues/" + (index + 1),
              })));
            }
            const input = await request.json();
            const fail = issueFailures.get(input.title);
            issueFailures.delete(input.title);
            if (fail === "before") return new Response(null, { status: 504 });
            issues.push(input);
            const callback = afterIssue;
            afterIssue = undefined;
            await callback?.();
            if (fail === "after") return new Response(null, { status: 504 });
            return Response.json({
              html_url:
                "https://github.com/example/project/issues/" + issues.length,
              assignees: [{ login: "alex" }],
            });
          }
          if (target.hostname === "example.atlassian.net") {
            assert.match(request.headers.get("Authorization"), /^Basic /);
            if (request.method === "GET") {
              assert.equal(target.pathname, "/rest/api/3/project/ENG");
              await beforeProjectRead?.();
              return Response.json({ key: "ENG" });
            }
            assert.equal(target.pathname, "/rest/api/3/issue");
            const { fields } = await request.json();
            assert.equal(fields.project.key, "ENG");
            assert.equal(fields.description.type, "doc");
            assert.ok(fields.description.content.some((paragraph) =>
              paragraph.content.some((node) => node.marks?.[0]?.type === "link")));
            assert.equal(fields.assignee, undefined);
            return Response.json({ key: "ENG-42" }, { status: 201 });
          }
          if (target.hostname === "api.trello.com") {
            assert.equal(request.headers.get("Authorization"), 'OAuth oauth_consumer_key="fixturekey", oauth_token="fixturetoken"');
            if (request.method === "GET") return Response.json({ name: "To do" });
            assert.equal(target.pathname, "/1/cards");
            const input = await request.json();
            assert.equal(input.idList, "0123456789abcdef01234567");
            assert.match(input.desc, /\?segment=s1/);
            return Response.json({ url: "https://trello.com/c/fixture" });
          }
          if (target.hostname === "api.linear.app") {
            const { query, variables } = await request.json();
            if (query.includes("query TraceFollowup")) {
              assert.equal(variables.issueId, "ENG-314");
              if (!trackedLinearIssue) return Response.json({ data: { issue: null } });
              if (variables.type) assert.equal(variables.teamId, "fixture-team");
              return Response.json({ data: {
                issue: { id: trackedLinearIssue.id, archivedAt: null, team: { id: "fixture-team" },
                  state: { id: "state-" + trackedLinearIssue.status, type: trackedLinearIssue.status } },
                team: { states: { nodes: [
                  { id: "later-" + variables.type, type: variables.type, position: 10 },
                  { id: "state-" + variables.type, type: variables.type, position: 0 },
                ], pageInfo: { hasNextPage: false } } },
              } });
            }
            if (query.includes("mutation TraceIssueStatus")) {
              assert.equal(variables.id, trackedLinearIssue.id);
              assert.deepEqual(Object.keys(variables.input), ["stateId"]);
              const stateId = variables.input.stateId;
              assert.match(stateId, /^state-(started|completed)$/);
              trackedLinearIssue.status = stateId.slice("state-".length);
              followupStatusRequests.push(trackedLinearIssue.status);
              if (timeoutAfterStatus) return new Response(null, { status: 504 });
              return Response.json({ data: { issueUpdate: { success: true,
                issue: { id: trackedLinearIssue.id, state: { id: stateId } } } } });
            }
            if (query.includes("FindTraceIssue")) {
              const id = variables.filter.or[0].id.eq;
              const marker = variables.filter.or[1].description.contains;
              return Response.json({ data: { issues: {
                nodes: [...linearIssues.values()].filter((issue) =>
                  issue.id === id || issue.description.includes(marker)),
                pageInfo: { hasNextPage: false, endCursor: null },
              } } });
            }
            const input = variables.input;
            assert.match(input.id, /^[a-f0-9-]{36}$/);
            if (input.title === "Add the cursor parameter to the audit log endpoint") {
              assert.equal(trackedLinearIssue, undefined, "Trace must create only one issue");
              const issue = { id: input.id, url: "https://linear.app/trace/issue/ENG-314",
                description: input.description, assignee: { id: "alex" }, status: "backlog" };
              trackedLinearIssue = issue;
              return Response.json({ data: { issueCreate: { success: true, issue } } });
            }
            const issue = { id: input.id, description: "", url: "https://linear.app/trace/issue/ENG-42" };
            linearIssues.set(issue.id, issue);
            return new Response(null, { status: 504 });
          }
          const raw = await request.text();
          const headers = new Headers(request.headers);
          received.push({
            raw,
            headers,
            method: request.method,
            url: request.url,
          });
          return new Response(null, {
            status: (await verifyWebhook(signingSecret, headers, raw))
              ? 204
              : 401,
          });
        },
      });
      config.workers[0].config.assets = {
        directory: assetRoot,
        hasUserWorker: true,
      };
      return new Miniflare({ ...config, resourcePersistencePath: storage });
    }
    let worker = launch(primary);

    try {
      let base = await worker.ready;
      assert.ok(script, "build includes a fingerprinted client script");
      const asset = await fetch(new URL(script, base));
      assert.equal(asset.status, 200);
      assert.match(asset.headers.get("cache-control"), /public.*immutable/);
      assert.ok((await asset.arrayBuffer()).byteLength > 0);
      const missing = await fetch(
        new URL("/_next/static/missing-test-file.js", base),
      );
      assert.equal(missing.status, 404);

      async function call(path, method, data, cookie, status) {
        const response = await fetch(new URL(path, base), {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(cookie ? { Cookie: cookie } : {}),
          },
          ...(data ? { body: JSON.stringify(data) } : {}),
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(response.status, status, await response.clone().text());
        if (path !== "/test-init") {
          assert.equal(
            response.headers.get("cache-control"),
            "private, no-store",
          );
          assert.equal(
            response.headers.get("cloudflare-cdn-cache-control"),
            "no-store",
          );
          assert.equal(response.headers.get("x-frame-options"), "DENY");
          assert.equal(response.headers.get("cdn-cache-control"), "no-store");
          assert.equal(response.headers.get("referrer-policy"), "same-origin");
          assert.equal(
            response.headers.get("x-content-type-options"),
            "nosniff",
          );
          if (tls)
            assert.match(
              response.headers.get("strict-transport-security"),
              /max-age=31536000/,
            );
        }
        return response;
      }
      async function login(data) {
        const response = await call("/api/auth/login", "POST", data, "", 200);
        const header = response.headers.get("Set-Cookie");
        assert.match(header, /; HttpOnly; SameSite=Lax;/);
        assert.equal(/; Secure(?:;|$)/.test(header), !!tls);
        return header.split(";")[0];
      }
      await call("/test-init", "POST", {}, "", 204);
      const bootstrap = await login({ password: bootstrapPassword });
      await call(
        "/api/admin",
        "POST",
        {
          action: "member",
          username: "admin",
          role: "admin",
          password: adminPassword,
        },
        bootstrap,
        200,
      );
      await call("/api/auth/session", "GET", null, bootstrap, 401);
      await call(
        "/api/auth/login",
        "POST",
        { password: bootstrapPassword },
        "",
        401,
      );
      const admin = await login({ username: "admin", password: adminPassword });
      await call(
        "/api/admin",
        "POST",
        {
          action: "workspace",
          id: "second-team",
          name: "Second team",
          username: "admin",
          password: adminPassword,
        },
        admin,
        200,
      );
      const other = await login({
        workspace: "second-team",
        username: "admin",
        password: adminPassword,
      });
      if (tls) {
        assert.equal(base.origin, canonical);
        const denied = await fetch(
          new URL(
            "/api/workspace",
            base.href.replace("127.0.0.1", "localhost"),
          ),
        );
        assert.equal(denied.status, 421);
        const rejected = await worker.dispatchFetch(
          "http://127.0.0.1:18443/api/workspace",
        );
        assert.equal(rejected.status, 421);
      }
      for (const cookie of [admin, other, ""]) {
        const page = await fetch(new URL("/workspace/meetings", base), {
          headers: cookie ? { Cookie: cookie } : {},
          redirect: "manual",
        });
        assert.equal(page.status, cookie ? 200 : 307);
        assert.equal(page.headers.get("cache-control"), "private, no-store");
        assertNoCredentials(await page.text());
      }
      const savedWebhook = await call(
        "/api/integrations/webhook",
        "POST",
        {
          action: "save",
          config: { webhookUrl: endpoint, token: signingSecret },
          updatedAt: "",
        },
        admin,
        200,
      );
      assert.equal(savedWebhook.headers.get("cache-control"), "private, no-store");
      const webhookBody = await savedWebhook.text();
      assertNoCredentials(webhookBody);
      assert.equal(webhookBody.includes(endpoint), false);
      const { state: webhookState } = JSON.parse(webhookBody);
      const sendPath = "/api/meetstream/bots";
      const sendInput = {
        meetingLink: "https://meet.google.com/abc-defg-hij",
        requestId: crypto.randomUUID(),
      };
      await call(sendPath, "POST", sendInput, "", 401);
      await call(sendPath, "POST", sendInput, other, 409);
      const agentWorkspace = await (await call("/api/workspace", "GET", null, admin, 200)).json();
      const otherWorkspace = await (await call("/api/workspace", "GET", null, other, 200)).json();
      assert.equal(agentWorkspace.meetingAgentEnabled, true);
      assert.equal(otherWorkspace.meetingAgentEnabled, false);
      assertNoCredentials(JSON.stringify(agentWorkspace));
      assertNoCredentials(JSON.stringify(otherWorkspace));
      assert.equal(agentWorkspace.integrationStates.webhook.config.webhookUrl, undefined);
      await call(sendPath, "POST", { ...sendInput, settings: { runAgent: true } }, other, 409);
      await call(
        sendPath,
        "POST",
        { ...sendInput, meetingLink: "https://example.com/meeting" },
        admin,
        400,
      );
      const { botId } = await (
        await call(sendPath, "POST", sendInput, admin, 200)
      ).json();
      assert.equal(botId, fixtureBotId);
      assert.deepEqual(
        await (await call(sendPath, "POST", sendInput, admin, 200)).json(),
        { botId },
      );
      assert.equal(botRequests.size, 1);
      for (const settings of [
        { provider: "deepgram_streaming" },
        { provider: "meetstream", model: "unsupported" },
        { provider: "deepgram", audio_required: false },
      ]) {
        await call(sendPath, "POST", { ...sendInput, requestId: crypto.randomUUID(), settings }, admin, 400);
      }
      const customInput = {
        meetingLink: "https://meet.google.com/abc-defg-xyz",
        requestId: crypto.randomUUID(),
        settings: {
          name: "Engineering Notes",
          provider: "assemblyai",
          language: "en_us",
          model: "universal-2",
          recordVideo: true,
          videoLayout: "grid_view",
          runAgent: true,
        },
      };
      await call(sendPath, "POST", customInput, admin, 200);
      await call(sendPath, "POST", customInput, admin, 200);
      assert.equal(botRequests.size, 2);
      const listBots = (cookie) =>
        call(sendPath, "GET", null, cookie, 200).then((response) => response.json());
      assert.deepEqual((await listBots(admin)).bots.map((bot) => bot.id).sort(), [botId, secondBotId].sort());
      assert.deepEqual((await listBots(other)).bots, []);
      const statusPath = sendPath + "?botId=" + botId;
      const readStatus = (path = statusPath) =>
        call(path, "GET", null, admin, 200).then((response) => response.json()).then((data) => data.status);
      assert.deepEqual(await readStatus(), { label: "In meeting", canStop: true, ready: false, settled: false });
      assert.equal((await readStatus(sendPath + "?botId=" + secondBotId)).label, "Waiting to join");
      await call(statusPath, "GET", null, other, 404);
      await call(sendPath, "POST", { action: "stop", botId }, "", 401);
      await call(sendPath, "POST", { action: "stop", botId }, other, 404);
      assert.deepEqual(
        await (
          await call(sendPath, "POST", { action: "stop", botId }, admin, 200)
        ).json(),
        { botId },
      );
      await call(sendPath, "POST", { action: "stop", botId }, admin, 200);
      assert.equal(botStopRequests, 1);
      assert.ok((await listBots(admin)).bots.find((bot) => bot.id === botId).stopRequestedAt);
      botStatus = "Stopped";
      assert.equal((await readStatus()).label, "Bot left · Processing transcript");
      botStatus = "Done";
      assert.equal((await readStatus()).ready, false);
      const meetingInput = {
        title: "Cursor review",
        botId,
        date: new Date().toISOString(),
        useAI: false,
      };
      await call("/api/meetings", "POST", meetingInput, other, 404);
      await call("/api/meetings", "POST", meetingInput, admin, 409);
      transcriptReady = true;
      assert.equal((await readStatus()).ready, true);
      const { meeting } = await (
        await call("/api/meetings", "POST", meetingInput, admin, 201)
      ).json();
      assert.equal(meeting.source, "meetstream");
      const { discussions, ...stored } = meeting;
      const database = await worker.getD1Database("DB");
      await database.prepare("UPDATE meetings SET data=? WHERE id=?")
        .bind(JSON.stringify({ ...stored, decisions: discussions }), meeting.id).run();
      const duplicate = await (await call("/api/meetings", "POST", meetingInput, admin, 200)).json();
      assert.deepEqual(duplicate.meeting.discussions, discussions);
      assert.equal(duplicate.meeting.decisions, undefined);
      assert.deepEqual((await listBots(admin)).bots.map((bot) => [bot.id, bot.meetingId]).sort(), [
        [botId, meeting.id], [secondBotId, null],
      ]);
      const { events: botEvents } = await (await call("/api/admin", "GET", null, admin, 200)).json();
      assert.equal(botEvents.filter((event) => event.action === "meetstream.bot.sent").length, 2);
      assert.equal(botEvents.filter((event) => event.action === "meetstream.bot.stop_requested").length, 1);
      assert.equal(meeting.segments[0].speaker, "Alex");
      assert.equal(meeting.segments[0].start, 1);
      assert.ok(meeting.discussions.length);
      assert.ok(meeting.actions.length);
      const path = "/api/meetings/" + meeting.id;
      const meetingIndex = await (await call("/api/workspace", "GET", null, admin, 200)).json();
      const preview = meetingIndex.meetings.find((row) => row.id === meeting.id);
      assert.equal(preview.segments, undefined);
      assert.deepEqual(preview.turns, meeting.segments.map(({ id, speaker, start }) => ({ id, speaker, start })));
      const detail = await (await call(path, "GET", null, admin, 200)).json();
      assert.deepEqual(detail.meeting.segments, meeting.segments);
      await call(path, "GET", null, other, 404);
      await call(path, "GET", null, "", 401);
      const audioPath = path + "/audio";
      await call(audioPath, "GET", null, "", 401);
      await call(audioPath, "GET", null, other, 404);
      const audioResponse = await worker.dispatchFetch(new URL(audioPath, base), {
        headers: { Cookie: admin, Range: "bytes=44-63" },
      });
      assert.equal(audioResponse.status, 206);
      assert.equal(audioResponse.headers.get("Content-Range"), "bytes 44-63/204");
      assert.equal(audioResponse.headers.get("Content-Type"), "audio/wav");
      assert.match(audioResponse.headers.get("Cache-Control"), /no-store/);
      assert.equal((await audioResponse.arrayBuffer()).byteLength, 20);
      await call(
        "/api/admin",
        "POST",
        {
          action: "member",
          username: "editor",
          role: "editor",
          password: adminPassword,
        },
        admin,
        200,
      );
      const editor = await login({
        username: "editor",
        password: adminPassword,
      });
      await call(audioPath, "GET", null, editor, 403);
      await call(path, "PUT", { ...meeting, reviewed: true }, editor, 403);
      await call(path, "PUT", meeting, other, 404);
      await call("/api/admin", "GET", null, editor, 403);

      const { meeting: reviewed } = await (
        await call(
          path,
          "PUT",
          {
            ...meeting,
            reviewed: true,
            discussions: meeting.discussions.map((discussion) => ({
              ...discussion,
              approved: true,
            })),
          },
          admin,
          200,
        )
      ).json();
      const publish = {
        meetingId: meeting.id,
        revision: reviewed.revision,
        destinations: ["webhook"],
      };
      await call(
        "/api/publish",
        "POST",
        { ...publish, revision: meeting.revision },
        admin,
        409,
      );
      const results = await Promise.all(
        [1, 2].map(async () =>
          (await call("/api/publish", "POST", publish, admin, 200)).json(),
        ),
      );
      assert.deepEqual(results.map(({ sent }) => sent).sort(), [0, 1]);
      assert.deepEqual(results.map(({ skipped }) => skipped).sort(), [0, 1]);
      const sent = results.find((result) => result.sent);
      assert.equal(sent.deliveries.length, 1);
      assert.equal(sent.deliveries[0].status, "sent");
      assert.equal(received.length, 1);
      const [{ raw, headers, method, url }] = received;
      assert.equal(method, "POST");
      assert.equal(url, endpoint);
      assert.equal(
        await verifyWebhook(signingSecret, headers, raw + " "),
        false,
      );
      const event = JSON.parse(raw);
      assert.equal(event.event, "meeting.reviewed");
      assert.equal(event.id, sent.deliveries[0].id);
      assert.equal(event.id, headers.get("X-Trace-Delivery"));
      assert.equal(event.meeting.revision, reviewed.revision);
      assert.deepEqual(event.discussions, reviewed.discussions);
      assert.deepEqual(event.actions, []);
      assert.ok(event.evidence.length);
      for (const segment of event.evidence) {
        const evidence = new URL(segment.url);
        assert.equal(evidence.origin, base.origin);
        assert.equal(evidence.searchParams.get("segment"), segment.id);
        assert.ok(
          reviewed.discussions.some((discussion) =>
            discussion.evidence.includes(segment.id),
          ),
        );
      }
      const snapshot = await (
        await call("/api/workspace", "GET", null, admin, 200)
      ).json();
      assert.equal(snapshot.meetings[0].id, meeting.id);
      assert.deepEqual(Object.keys(snapshot.access).sort(), [
        "actor",
        "role",
        "workspace",
      ]);
      const otherSnapshot = await (
        await call("/api/workspace", "GET", null, other, 200)
      ).json();
      assert.deepEqual(otherSnapshot.meetings, []);
      assert.deepEqual(otherSnapshot.deliveries, []);
      const cached = new Map();
      let hits = 0;
      // Model a shared cache keyed by URL that honors origin storage policy.
      const proxy = createServer(async (req, res) => {
        try {
          const path = req.url;
          let entry = cached.get(path);
          if (entry) hits++;
          else if (path === "/public-control") {
            entry = {
              status: 200,
              policy: "public, max-age=60",
              body: "cache control fixture",
            };
          } else {
            const upstream = await fetch(new URL(path, base), {
              headers: req.headers.cookie ? { Cookie: req.headers.cookie } : {},
              redirect: "manual",
            });
            entry = {
              status: upstream.status,
              policy: upstream.headers.get("Cache-Control") ?? "",
              body: await upstream.text(),
            };
          }
          if (
            entry.status === 200 &&
            !/\b(?:private|no-store)\b/i.test(entry.policy)
          )
            cached.set(path, entry);
          res.writeHead(entry.status, { "Cache-Control": entry.policy });
          res.end(entry.body);
        } catch {
          res.writeHead(502).end();
        }
      });
      proxy.listen(0, "127.0.0.1");
      await once(proxy, "listening");
      try {
        const proxyOrigin = `http://127.0.0.1:${proxy.address().port}`;
        for (const cookie of [admin, other, ""]) {
          const response = await fetch(proxyOrigin + "/api/workspace", {
            headers: cookie ? { Cookie: cookie } : {},
          });
          const data = await response.json();
          assert.equal(response.status, cookie ? 200 : 401);
          if (cookie)
            assert.deepEqual(
              data.meetings,
              cookie === admin ? snapshot.meetings : [],
            );
        }
        assert.equal(hits, 0);
        for (let index = 0; index < 2; index++)
          assert.equal(
            await (await fetch(proxyOrigin + "/public-control")).text(),
            "cache control fixture",
          );
        assert.equal(hits, 1);
      } finally {
        await new Promise((done) => proxy.close(done));
      }
      for (const options of [
        { method: "HEAD" },
        { headers: { RSC: "1", Cookie: admin } },
      ]) {
        const response = await fetch(new URL("/workspace/meetings", base), {
          ...options,
          redirect: "manual",
        });
        assert.equal(
          response.headers.get("Cache-Control"),
          "private, no-store",
        );
      }

      await call("/api/workspace", "GET", null, "", 401);
      await worker.dispose();
      // A stopped copy includes SQLite data, WAL and runtime metadata together.
      cpSync(primary, backup, { recursive: true });
      cpSync(backup, recovered, { recursive: true });
      const databases = globSync("**/*.sqlite", { cwd: recovered });
      const d1Path = databases.find((path) => {
        const db = new DatabaseSync(join(recovered, path), { readOnly: true });
        try {
          return db
            .prepare("SELECT 1 FROM sqlite_master WHERE name='sessions'")
            .get();
        } finally {
          db.close();
        }
      });
      assert.ok(d1Path, "backup contains application D1 data");
      const restoredDb = new DatabaseSync(join(recovered, d1Path));
      try {
        assert.equal(
          restoredDb.prepare("PRAGMA integrity_check").get().integrity_check,
          "ok",
        );
        restoredDb.exec(
          "BEGIN; DELETE FROM sessions; DELETE FROM login_limits; COMMIT;",
        );
      } finally {
        restoredDb.close();
      }
      worker = launch(recovered, true);
      base = await worker.ready;
      await call("/api/auth/session", "GET", null, admin, 401);
      await call("/api/auth/session", "GET", null, other, 401);
      const restoredAdmin = await login({
        username: "admin",
        password: adminPassword,
      });
      const restored = await (
        await call("/api/workspace", "GET", null, restoredAdmin, 200)
      ).json();
      assert.deepEqual(restored.meetings, snapshot.meetings);
      assert.deepEqual(restored.deliveries, snapshot.deliveries);
      assert.equal(restored.integrations.webhook, true);
      const restoredAudit = await (
        await call("/api/admin", "GET", null, restoredAdmin, 200)
      ).json();
      assert.equal(
        restoredAudit.events.filter(
          (event) =>
            event.action === "delivery.sent:webhook" &&
            event.target === meeting.id,
        ).length,
        1,
      );

      const restoredOther = await login({
        workspace: "second-team",
        username: "admin",
        password: adminPassword,
      });
      assert.deepEqual(
        (
          await (
            await call("/api/workspace", "GET", null, restoredOther, 200)
          ).json()
        ).meetings,
        [],
      );
      await call("/api/publish", "POST", publish, restoredAdmin, 503);
      assert.equal(received.length, 1);
      await worker.dispose();
      worker = launch(recovered);
      base = await worker.ready;
      const repeated = await (
        await call("/api/publish", "POST", publish, restoredAdmin, 200)
      ).json();
      assert.equal(repeated.sent, 0);
      assert.equal(repeated.skipped, 1);
      assert.equal(received.length, 1);
      const large = await (
        await call(
          "/api/meetings",
          "POST",
          {
            title: "Batch review",
            transcript: Array.from(
              { length: 6 },
              (_, index) =>
                `[00:0${index + 1}] Alex: I will write specification ${index + 1}.`,
            ).join("\n"),
            date: new Date().toISOString(),
            useAI: false,
          },
          restoredAdmin,
          201,
        )
      ).json();
      const batchMeeting = large.meeting;
      const batchReviewed = await (
        await call(
          "/api/meetings/" + batchMeeting.id,
          "PUT",
          {
            ...batchMeeting,
            reviewed: true,
            actions: batchMeeting.actions.map((action) => ({
              ...action,
              approved: true,
            })),
          },
          restoredAdmin,
          200,
        )
      ).json();
      const batch = {
        meetingId: batchMeeting.id,
        revision: batchReviewed.meeting.revision,
        destinations: ["github"],
      };
      const firstBatch = await (
        await call("/api/publish", "POST", {
          ...batch, itemIds: batchReviewed.meeting.actions.slice(0, 4).map((item) => item.id),
        }, restoredAdmin, 200)
      ).json();
      assert.deepEqual([firstBatch.sent, firstBatch.remaining], [4, 0]);
      const temporaryReviewer = await login({
        username: "admin",
        password: adminPassword,
      });
      afterIssue = () =>
        call("/api/auth/logout", "POST", {}, temporaryReviewer, 200);
      await call("/api/publish", "POST", batch, temporaryReviewer, 401);
      assert.equal(issues.length, 5);
      const resumed = await (
        await call("/api/publish", "POST", batch, restoredAdmin, 200)
      ).json();
      assert.deepEqual(
        [resumed.sent, resumed.skipped, resumed.remaining],
        [1, 5, 0],
      );
      assert.equal(issues.length, 6);
      assert.equal(new Set(issues.map((issue) => issue.title)).size, 6);
      const { meeting: recoveryMeeting } = await (await call("/api/meetings", "POST", {
        title: "Delivery recovery",
        date: new Date().toISOString(),
        transcript: "[00:01] Alex: I will verify the cursor behavior.\n[00:02] Alex: I will review the query plan.",
      }, restoredAdmin, 201)).json();
      const { meeting: recoveryReviewed } = await (await call(
        "/api/meetings/" + recoveryMeeting.id, "PUT", {
          ...recoveryMeeting,
          reviewed: false,
          actions: recoveryMeeting.actions.map((item) => ({ ...item, approved: true })),
        }, restoredAdmin, 200,
      )).json();
      issueFailures.set(recoveryReviewed.actions[0].title, "after");
      issueFailures.set(recoveryReviewed.actions[1].title, "before");
      const recoveryPublish = {
        meetingId: recoveryReviewed.id, revision: recoveryReviewed.revision, destinations: ["github", "linear"],
      };
      const attempts = await (await call("/api/publish", "POST", recoveryPublish, restoredAdmin, 200)).json();
      const findAttempt = (item, destination) => attempts.deliveries.find((d) =>
        d.meetingId === recoveryReviewed.id && d.itemId === item.id && d.destination === destination);
      const existingIssueDelivery = findAttempt(recoveryReviewed.actions[0], "github");
      const missingIssueDelivery = findAttempt(recoveryReviewed.actions[1], "github");
      const linearIssueDelivery = findAttempt(recoveryReviewed.actions[0], "linear");
      const recover = (delivery, action, actor = restoredAdmin, status = 200) =>
        call("/api/publish/recover", "POST", {
          deliveryId: delivery.id, revision: recoveryReviewed.revision, action,
        }, actor, status).then((response) => response.json());
      assert.equal(existingIssueDelivery.status, "uncertain");
      assert.equal(missingIssueDelivery.status, "uncertain");
      await recover(existingIssueDelivery, "check", "", 401);
      assert.equal((await recover(existingIssueDelivery, "check")).outcome, "found");
      assert.equal((await recover(linearIssueDelivery, "check")).outcome, "found");
      assert.equal((await recover(missingIssueDelivery, "check")).canRetry, false);
      const db = await worker.getD1Database("DB");
      await db.prepare("UPDATE deliveries SET attempted_at=? WHERE id=?")
        .bind(Date.now() - 120_000, missingIssueDelivery.id).run();
      assert.equal((await recover(missingIssueDelivery, "check")).canRetry, true);
      const competing = await Promise.all([1, 2].map(() => worker.dispatchFetch(
        new URL("/api/publish/recover", base),
        { method: "POST", headers: { "Content-Type": "application/json", Cookie: restoredAdmin },
          body: JSON.stringify({ deliveryId: missingIssueDelivery.id, revision: recoveryReviewed.revision, action: "retry" }) },
      )));
      assert.ok(competing.some((response) => response.ok));
      assert.equal(issues.length, 8);
      assert.equal(issues.filter((issue) => issue.title === recoveryReviewed.actions[1].title).length, 1);
      assert.equal((await recover(missingIssueDelivery, "check")).outcome, "found");
      await call(
        "/api/integrations/webhook?updatedAt=" + encodeURIComponent(webhookState.updatedAt),
        "DELETE",
        null,
        restoredAdmin,
        200,
      );
      const logout = await call(
        "/api/auth/logout",
        "POST",
        {},
        restoredAdmin,
        200,
      );
      assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
      assert.equal(
        /; Secure(?:;|$)/.test(logout.headers.get("set-cookie")),
        !!tls,
      );
      await call("/api/auth/session", "GET", null, restoredAdmin, 401);
      const nextSession = await login({
        username: "admin",
        password: adminPassword,
      });
      const { actor, events } = await (
        await call("/api/admin", "GET", null, nextSession, 200)
      ).json();
      for (const action of [
        "integration.saved",
        "integration.disconnected",
        "meeting.review_changed",
        "delivery.claimed:webhook",
        "delivery.sent:webhook",
        "session.signed_out",
      ])
        assert.equal(
          events.filter(
            (entry) => entry.action === action && entry.actor === actor,
          ).length,
          action === "meeting.review_changed" ? 3
            : action === "session.signed_out" ? 2 : 1,
        );
      const recoveryEvents = events.filter((event) => event.target === recoveryReviewed.id);
      assert.ok(recoveryEvents.some((event) => event.action === "delivery.recovered:linear"));
      assert.ok(recoveryEvents.some((event) => event.action === "delivery.recovered:github"));
      assert.equal(recoveryEvents.filter((event) => event.action === "delivery.retried:github").length, 1);
      const configs = {
        jira: { site: "https://example.atlassian.net", email: "test@example.net",
          token: "fixture-jira-token", projectKey: "ENG" },
        trello: { apiKey: "fixturekey", token: "fixturetoken", listId: "0123456789abcdef01234567" },
      };
      for (const [provider, config] of Object.entries(configs)) {
        const { state } = await (await call("/api/integrations/" + provider, "POST",
          { action: "save", config, updatedAt: "" }, nextSession, 200)).json();
        assert.equal(state.configured, true);
        assert.equal(state.config.token, undefined);
        assert.equal(state.config.apiKey, undefined);
      }
      const trackerPublish = {
        ...recoveryPublish,
        destinations: ["jira", "trello"],
        itemIds: [recoveryReviewed.actions[0].id],
      };
      const trackerResult = await (await call("/api/publish", "POST", trackerPublish, nextSession, 200)).json();
      assert.equal(trackerResult.sent, 2);
      assert.equal(trackerResult.deliveries.find((item) => item.destination === "jira").url,
        "https://example.atlassian.net/browse/ENG-42");
      assert.equal(trackerResult.deliveries.find((item) => item.destination === "trello").url,
        "https://trello.com/c/fixture");
      const trackerRepeat = await (await call("/api/publish", "POST", trackerPublish, nextSession, 200)).json();
      assert.equal(trackerRepeat.sent, 0);
      assert.equal(trackerRepeat.skipped, 2);

      const jiraPath = "/api/integrations/jira";
      const jiraVersion = async () => (await (await call(
        "/api/workspace", "GET", null, nextSession, 200,
      )).json()).integrationStates.jira;
      const original = await jiraVersion();
      const saveJira = (cookie, updatedAt, status) => call(jiraPath, "POST",
        { action: "save", config: { ...configs.jira, issueType: "Bug" }, updatedAt }, cookie, status);
      await saveJira(nextSession, "", 409);
      await call(jiraPath + "?updatedAt=", "DELETE", null, nextSession, 409);

      async function duringProjectRead(cookie, updatedAt, status, change) {
        const started = Promise.withResolvers();
        const resume = Promise.withResolvers();
        beforeProjectRead = () => {
          started.resolve();
          return resume.promise;
        };
        const saving = saveJira(cookie, updatedAt, status);
        try {
          await Promise.race([started.promise, saving.then(() => {
            throw new Error("Save completed before provider verification");
          })]);
          await change();
        } finally {
          beforeProjectRead = undefined;
          resume.resolve();
          await saving;
        }
      }
      await duringProjectRead(nextSession, original.updatedAt, 409, () =>
        call(jiraPath + "?updatedAt=" + encodeURIComponent(original.updatedAt), "DELETE", null, nextSession, 200));
      const disconnected = await jiraVersion();
      assert.equal(disconnected.configured, false);
      assert.notEqual(disconnected.updatedAt, original.updatedAt);

      await call("/api/admin", "POST", { action: "member", role: "admin",
        username: "temporary-admin", password: adminPassword }, nextSession, 200);
      const tempSession = await login({ username: "temporary-admin", password: adminPassword });
      const { members } = await (await call("/api/admin", "GET", null, nextSession, 200)).json();
      const temporaryAdmin = members.find((member) => member.username === "temporary-admin");
      await duringProjectRead(tempSession, disconnected.updatedAt, 403, () =>
        call("/api/admin", "POST", { action: "remove", id: temporaryAdmin.id }, nextSession, 200));
      assert.deepEqual(await jiraVersion(), disconnected);

      const meetingOn = async (day, words, project = "Audit log") => (await (await call(
        "/api/meetings", "POST", { title: "Daily follow-up " + day, project,
          date: `2035-01-${day}T09:00:00.000Z`, transcript: `[00:21] Alex: ${words}` }, nextSession, 201,
      )).json()).meeting;
      const approveActions = async (draft) => (await (await call(
        "/api/meetings/" + draft.id, "PUT", { ...draft, reviewed: true,
          actions: draft.actions.map((action) => ({ ...action, approved: true })) }, nextSession, 200,
      )).json()).meeting;
      const publishLinear = async (draft, status = 200) => (await (await call(
        "/api/publish", "POST", { meetingId: draft.id, revision: draft.revision, destinations: ["linear"] },
        nextSession, status,
      )).json());
      const earlyImport = await meetingOn("04", "I will add the cursor parameter to the audit log endpoint.");
      assert.equal(earlyImport.actions[0].linearFollowup, undefined);
      const initialTask = await approveActions(await meetingOn("01",
        "Please create an issue to add the cursor parameter to the audit log endpoint."));
      assert.equal((await publishLinear(initialTask)).sent, 1);
      assert.equal(trackedLinearIssue.status, "backlog");

      const lateApproved = await approveActions(earlyImport);
      await publishLinear(lateApproved, 409);
      const relinked = (await (await call("/api/meetings/" + earlyImport.id, "POST", {
        kind: "refreshLinear", revision: lateApproved.revision,
      }, nextSession, 200)).json()).meeting;
      assert.equal(relinked.actions[0].linearFollowup.identifier, "ENG-314");
      assert.equal(relinked.actions[0].linearFollowup.status, null);
      assert.equal(relinked.actions[0].approved, false);

      const differentProject = await meetingOn("02", "Today, the cursor parameter to the audit log endpoint is done.", "Other");
      assert.equal(differentProject.actions.length, 0);
      const progress = await meetingOn("02", "I’m working on adding the cursor parameter to the audit log endpoint.");
      assert.equal(progress.actions.length, 1);
      assert.equal(progress.actions[0].linearFollowup.status, "started");
      assert.equal(progress.actions[0].linearFollowup.identifier, "ENG-314");
      assert.deepEqual(progress.actions[0].evidence, ["s1"]);
      await publishLinear(progress, 409);
      const approvedProgress = await approveActions(progress);
      assert.equal((await publishLinear(approvedProgress)).sent, 1);
      assert.equal(trackedLinearIssue.status, "started");
      assert.equal((await publishLinear(approvedProgress)).skipped, 1);

      const oldUpdate = await approveActions(await meetingOn("01", "ENG-314 is ready to start."));
      await publishLinear(oldUpdate, 409);
      const completion = await approveActions(await meetingOn("03", "The cursor parameter to the audit log endpoint is done."));
      timeoutAfterStatus = true;
      const outcome = await publishLinear(completion);
      assert.equal(outcome.sent, 0);
      const completedDelivery = outcome.deliveries.find((item) => item.meetingId === completion.id);
      assert.equal(completedDelivery.status, "uncertain");
      assert.ok(completedDelivery.followupOf);
      assert.equal(trackedLinearIssue.status, "completed");
      const confirmed = await (await call("/api/publish/recover", "POST", {
        deliveryId: completedDelivery.id, revision: completion.revision, action: "check",
      }, nextSession, 200)).json();
      assert.equal(confirmed.outcome, "found");
      assert.equal(confirmed.deliveries.find((item) => item.id === completedDelivery.id).url, trackedLinearIssue.url);
      assert.deepEqual(followupStatusRequests, ["started", "completed"]);
    } finally {
      await worker.dispose();
      rmSync(state, { recursive: true, force: true });
    }
  },
);
