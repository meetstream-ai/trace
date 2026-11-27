# Trace · Engineering Discussion Agent

Trace is an early-stage, local-first project from [MeetStream](https://meetstream.ai). It turns engineering meetings into discussions, action items, and open questions. Review each draft against its timestamp, then export an ADR or publish approved work to your team’s tools.

[Quickstart for everyone](quickstart.md) · [Integrations](#connect-a-tool-when-you-need-it) · [Developer checks](#developer-checks)

## Start here

1. Install Git and Node.js **22.13 or newer** (Node 24 recommended). npm comes with Node.js.
2. Open a terminal and run:

   ```sh
   git clone https://github.com/meetstream-ai/trace.git
   cd trace
   npm ci
   npm start
   ```

   If you downloaded a ZIP, extract it, open a terminal in the folder containing this README, and start with `npm ci`.

3. Open [Trace on localhost](http://localhost:5173). For fresh setup, leave the workspace ID at `local_seedy`, leave **Username** blank, and use the generated `APP_PASSWORD` from `.env` in the repository root.
4. In **Workspace settings → Add access**, create a **Workspace member** with the **Admin** role and a password of at least 12 characters. Sign in with that username and password from then on. The setup password stops working once the first admin exists.
5. Open **Meetings → Import transcript** to paste or upload a transcript. The [quickstart](quickstart.md) has an example and shows how to review your first meeting.

Stop Trace with **Ctrl+C** in the original terminal. On macOS or Linux, you can also run `npm stop` in a second terminal in the same folder. If port 5173 is busy, stop the other app using it before retrying.

The first start creates an ignored `.env` with a generated setup password and session secret and applies database migrations. Local data stays in `.wrangler/state` between restarts. You can import, review, and export without a cloud account or API key. Keep `APP_SESSION_SECRET` stable while using the same database because it also protects saved integration credentials.

## Connect a tool when you need it

Connect **MeetStream** for meeting bots, transcript imports by ID, and audio playback when the recording is available. Connect **Linear, GitHub, Jira Cloud, or Trello** to publish action items. **Notion** receives ADRs, **Slack** receives meeting summaries, and an operator can allow a **signed webhook** destination.

Trace uses built-in extraction rules by default. Connecting Claude adds an opt-in extraction mode that sends the selected transcript to Anthropic. Publishing to a connected tool also sends the selected content outside localhost.

In **Integrations**, choose the service and save its connection. An Admin manages connections.

| Integration | Setup and output |
| --- | --- |
| **MeetStream** | Save the API key. Send a bot from **Meetings** or import by bot or transcript ID. Pick the bot name, post-call transcription provider, and optional language or model in **Bot settings**. A bot-backed recording enables timestamp playback while audio remains available. |
| **Linear** | Use a personal API key with access to read the team and create or update issues. Load teams and members, select a team, and optionally map speakers to users. Publishing a matched follow-up updates the existing issue status after review. |
| **GitHub** | Use a fine-grained token with Issues write permission for the selected repository. Enter `owner/repository`, load members, and optionally map speakers. Unmapped action owners can be assigned after issue creation. |
| **Jira Cloud** and **Trello** | Enter the Jira site, account email, API token, and project key, or the Trello API key, token, and list ID. Approved action items create issues or cards. |
| **Slack** | Save an incoming webhook URL for the intended channel. Publishing sends a meeting summary to that channel. |
| **Notion** | Share a parent page with an integration, then enter its key and the page link. Publishing creates a child page for each accepted ADR. |
| **Signed webhook** | Allow the exact HTTPS endpoint for the workspace in `TRACE_WEBHOOK_ENDPOINTS`. Add the endpoint and a signing secret in Integrations. The recipient verifies the signature against the original body and timestamp. |
| **Claude** | Save the Anthropic API key and select a model, then opt in when importing. Drafts are still subject to review and source evidence checks. |

If a Linear or GitHub request times out, use **Activity** to check the destination for the existing issue before retrying. An approved Linear follow-up can update the issue that Trace already created for the same work. Say the issue ID or use a clear task name in the same project. Review the match and supporting timestamp before publishing.

## Architecture

`Transcript → timestamped turns → drafts → review → export or publish`

| Where | What belongs there |
| --- | --- |
| [Workspace routes](app/workspace) and [workspace shell](components/trace-workspace.tsx) | Navigation, workspace data, permissions, and updates shared between screens. |
| [Meeting list](components/workspace/meeting-list.tsx) and [draft collections](components/workspace/draft-collection.tsx) | Search, filters, sorting, and links to individual meetings. |
| [Meeting review](components/workspace/meeting-detail.tsx), [recording playback](components/workspace/meeting-recording.tsx), and [draft forms](components/workspace/draft-dialogs.tsx) | Transcript evidence, corrections, and editing. |
| [Import dialog](components/workspace/import-meeting-dialog.tsx) and [meeting import API](app/api/meetings/route.ts) | Upload, MeetStream bot controls, transcript processing, and duplicate import handling. |
| [Publish dialog](components/workspace/publish-dialog.tsx), [publish API](app/api/publish/route.ts), and [recovery API](app/api/publish/recover/route.ts) | Approval controls, delivery history, and retries. |
| [`lib/types.ts`](lib/types.ts), [`lib/extract.ts`](lib/extract.ts), [`lib/review-corrections.ts`](lib/review-corrections.ts) | Shared meeting schema, extraction, and transcript-backed draft corrections. |
| [`lib/meetstream/`](lib/meetstream) | MeetStream bot lifecycle, transcript imports, and recording access. Bot requests enter through [the bot API](app/api/meetstream/bots/route.ts). |
| [`lib/integration-service.ts`](lib/integration-service.ts), [`lib/publish.ts`](lib/publish.ts), [`lib/issue-recovery.ts`](lib/issue-recovery.ts) | Workspace connections, outbound delivery, and Linear/GitHub reconciliation. |
| [`lib/server.ts`](lib/server.ts), [`lib/access.ts`](lib/access.ts), [`db/`](db), [`drizzle/`](drizzle) | Sessions, permissions, database access, schema, and migrations. |
| [`worker/index.ts`](worker/index.ts), [`scripts/run-framework.mjs`](scripts/run-framework.mjs) | Worker entry point and local startup. The local runtime emulates the Worker and D1 database. |

React renders the workspace, Vinext runs the routes, and Cloudflare D1 stores meeting data and delivery history. Drizzle defines the schema and migration files. Workspace permissions are checked on the server. Admins manage users and connections. Reviewers can approve and publish. Editors can import and edit drafts. Viewers can read.

Source evidence is preserved by transcript turn ID. The workspace list loads draft summaries and timestamp labels. Trace fetches the full transcript for an opened meeting or a selected draft that needs its source context. Revisions reject stale edits. The publishing ledger claims each meeting, output, and destination combination before sending it. Repeating a successful publish skips existing claims. After a timeout, check **Activity** before another send. Editing a draft after publication stays in Trace. Update the external record directly if you need it changed.

## Local data and credentials

Saved provider keys and webhook URLs are encrypted with AES-GCM. `APP_SESSION_SECRET` derives the encryption key and signs application sessions. Keep a private copy of `.env` with any backup of `.wrangler/state`. Stop the server before copying its SQLite-backed state. Keep the session secret unchanged when restoring saved credentials. [`.env.example`](.env.example) lists supported environment fallback names and contains placeholders.

Saved credentials stay out of browser storage and workspace API responses. Use scoped provider credentials, keep the server on loopback, and create a named admin during initial setup. Session cookies are HTTP-only, and the app sets the Secure attribute on HTTPS. Transcript links point to your running Trace instance.

## Optional Python meeting agent

The [Python package](meeting-agent/trace_meeting_agent/) receives MeetStream webhooks and dispatches one registered handler per event. The [incident example](meeting-agent/examples/incident.py) demonstrates `on_utterance` for completed phrases, `on_bot_stopped` for exits or failures, and `on_transcript_ready` for post-call transcripts. The receiver verifies signed lifecycle events. Live phrases use a secret webhook URL and wait for signed bot enrollment. Events are queued in SQLite before acknowledgement. Handlers can use `meeting.once` to reserve an outbound action and avoid duplicate attempts.

In the Python process environment, set `MEETSTREAM_API_KEY`, `TRACE_MEETING_AGENT_SIGNING_SECRET`, `TRACE_MEETING_AGENT_ID`, and `TRACE_MEETING_AGENT_LIVE_TOKEN`. The live token must be random and URL-safe. From `meeting-agent/`, run `python3 -m trace_meeting_agent examples.incident` to listen locally on port 8090.

For optional live events, MeetStream needs an HTTPS endpoint that reaches the receiver. Register its `/webhooks/lifecycle` path for MeetStream bot lifecycle and transcript events. Set `TRACE_MEETING_AGENT_ORIGIN` and the matching agent ID and live token in Trace's `.env`, then restart Trace and enable **Run meeting agent** in **Bot settings**. Keep the live URL out of proxy logs. The unit tests exercise handlers locally with fixture events and require no externally reachable endpoint.

## Developer checks

Run these commands from the cloned repository.

```sh
npm run typecheck
npm test
npm run test:worker
(cd meeting-agent && python3 -m unittest discover -s tests)
```

Run `npm run test:api` against a disposable local instance on port 5173. Run `npm run test:local` in a disposable checkout with an existing `.env` and port 5173 free. The worker suite uses a disposable database and mocked providers.

## References and license

The workflow was informed by MeetStream’s [Companion](https://github.com/meetstream-ai/companion), [TypeScript SDK](https://github.com/meetstream-ai/meetstream-node), and [Labs](https://github.com/meetstream-ai/labs).

Application code is [MIT licensed](LICENSE). DM Sans is distributed under the [SIL Open Font License](public/fonts/OFL.txt).
