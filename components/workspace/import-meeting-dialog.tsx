import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowDownToLine, AudioLines, FileText, LoaderCircle, Sparkles } from "lucide-react";
import Link from "next/link";
import { meetingPath } from "@/lib/navigation";
import { requestJson } from "@/lib/client";
import { botStopRetryMs, type IntegrationStatus, type Meeting, type MeetStreamBot, type MeetStreamBotStatus } from "@/lib/types";
import { botSettingsSchema, defaultBotSettings, type BotSettings } from "@/lib/meetstream/bot-settings";
import { BotSettingsFields } from "./bot-settings-fields";
import { Modal } from "./workspace-ui";

function localDate() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
    .toISOString().slice(0, 10);
}
export function ImportModal({
  initialSource,
  meetingAgentEnabled,
  onClose,
  onImported,
  signedIn,
  connections,
  defaultProject,
  botStorageKey,
}: {
  meetingAgentEnabled: boolean;
  onClose: () => void;
  onImported: (m: Meeting, d: boolean, audioChecked?: boolean) => void;
  signedIn: boolean;
  connections: IntegrationStatus;
  defaultProject: string;
  botStorageKey: string;
  initialSource: "paste" | "meetstream";
}) {
  const [source, setSource] = useState(initialSource),
    [title, setTitle] = useState(""),
    [project, setProject] = useState(defaultProject),
    [transcript, setTranscript] = useState(""),
    [transcriptId, setTranscriptId] = useState(""),
    [botId, setBotId] = useState(""),
    [selectedTrackedBotId, setSelectedTrackedBotId] = useState(""),
    [meetingLink, setMeetingLink] = useState(""),
    [settings, setSettings] = useState<BotSettings>(defaultBotSettings),
    [sendingBot, setSendingBot] = useState(false),
    [botAction, setBotAction] = useState(""),
    [bots, setBots] = useState<MeetStreamBot[]>([]),
    [botStatuses, setBotStatuses] = useState<Record<string, MeetStreamBotStatus>>({}),
    [botListError, setBotListError] = useState(""),
    [refreshBots, setRefreshBots] = useState(0),
    [date, setDate] = useState(() => localDate()),
    [showImported, setShowImported] = useState(false),
    [useAI, setUseAI] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const botRequest = useRef<{ inviteHash: string; id: string } | null>(null);
  const sending = useRef(false);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(botStorageKey);
      if (saved && /^[a-zA-Z0-9_-]{1,200}$/.test(saved)) setBotId(saved);
    } catch {
      // Older browser-only bot IDs can also be entered manually.
    }
  }, [botStorageKey]);

  useEffect(() => {
    if (source !== "meetstream") return;
    const signal = new AbortController();
    const settled = new Set<string>();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const { bots } = await requestJson<{ bots: MeetStreamBot[] }>(
          "/api/meetstream/bots", { signal: signal.signal },
        );
        if (signal.signal.aborted) return;
        setBots(bots);
        setBotListError("");
        const pending = bots.filter((bot) => !bot.meetingId && !settled.has(bot.id));
        if (!connections.meetstream) return;
        for (let i = 0; i < pending.length && !signal.signal.aborted; i += 4) {
          const results = await Promise.all(pending.slice(i, i + 4).map(async (bot) => {
            try {
              const { status } = await requestJson<{ status: MeetStreamBotStatus }>(
                `/api/meetstream/bots?botId=${encodeURIComponent(bot.id)}`, { signal: signal.signal },
              );
              if (status.settled) settled.add(bot.id);
              return [bot.id, status] as const;
            } catch {
              return [bot.id, { label: "Status unavailable", canStop: true, ready: false, settled: false }] as const;
            }
          }));
          if (!signal.signal.aborted)
            setBotStatuses((previous) => ({ ...previous, ...Object.fromEntries(results) }));
        }
      } catch (error) {
        if (!signal.signal.aborted) setBotListError((error as Error).message);
      } finally {
        if (!signal.signal.aborted) timer = setTimeout(refresh, 12000);
      }
    }
    void refresh();
    return () => {
      signal.abort();
      clearTimeout(timer);
    };
  }, [source, connections.meetstream, refreshBots]);

  async function sendBot() {
    const link = meetingLink.trim();
    if (sending.current || busy || !link || !connections.meetstream) return;
    const parsed = botSettingsSchema.safeParse({
      ...settings,
      name: settings.name.trim() || defaultBotSettings.name,
      language: settings.language?.trim() || undefined,
      model: settings.model?.trim() || undefined,
    });
    if (!parsed.success) {
      setError("Check the bot name, language code, and model in Bot settings.");
      return;
    }
    sending.current = true;
    setSendingBot(true);
    setError("");
    try {
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(link));
      const inviteHash = Array.from(new Uint8Array(hash), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      const retryKey = botStorageKey + ":pending:" + inviteHash;
      if (botRequest.current?.inviteHash !== inviteHash) {
        let saved = "";
        try { saved = sessionStorage.getItem(retryKey) ?? ""; } catch {}
        botRequest.current = { inviteHash, id: saved || crypto.randomUUID() };
        try { sessionStorage.setItem(retryKey, botRequest.current.id); } catch {}
      }
      const result = await requestJson<{ botId: string }>(
        "/api/meetstream/bots",
        {
          method: "POST",
          body: JSON.stringify({
            meetingLink: link,
            requestId: botRequest.current.id,
            settings: parsed.data,
          }),
        },
      );
      setBotId(result.botId);
      setSelectedTrackedBotId(result.botId);
      setRefreshBots((value) => value + 1);
      setTranscriptId("");
      setMeetingLink("");
      botRequest.current = null;
      try { sessionStorage.removeItem(retryKey); } catch {}
    } catch (e) {
      setError((e as Error).message);
    } finally {
      sending.current = false;
      setSendingBot(false);
    }
  }

  async function updateBot(action: "stop" | "track", id: string) {
    if (sending.current || busy) return;
    sending.current = true;
    setBotAction(`${action}:${id}`);
    setError("");
    try {
      await requestJson("/api/meetstream/bots", {
        method: "POST",
        body: JSON.stringify({ action, botId: id }),
      });
      if (action === "track") setSelectedTrackedBotId(id);
      setRefreshBots((value) => value + 1);
      if (action === "stop")
        setBots((previous) => previous.map((bot) =>
          bot.id === id ? { ...bot, stopRequestedAt: Date.now() } : bot,
        ));
    } catch (error) {
      setError((error as Error).message);
    } finally {
      sending.current = false;
      setBotAction("");
    }
  }

  const selectedBot = bots.find((bot) => bot.id === botId.trim());
  const importedBotCount = bots.filter((bot) => bot.meetingId).length;
  const visibleBots = bots.filter((bot) => showImported || !bot.meetingId);
  const readyToImport = source === "paste"
    ? Boolean(transcript.trim())
    : connections.meetstream && Boolean(transcriptId.trim() || (botId.trim() &&
      (selectedBot?.meetingId || botStatuses[botId.trim()]?.ready ||
        (!selectedBot && botId.trim() !== selectedTrackedBotId))));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (sending.current || busy || !readyToImport) return;
    if (!signedIn) {
      location.href = "/login";
      return;
    }
    setBusy(true);
    setError("");
    try {
      const data = await requestJson<{ meeting: Meeting; duplicate: boolean; audioChecked?: boolean }>("/api/meetings", {
        method: "POST",
        body: JSON.stringify({
          title,
          project,
          ...(source === "meetstream"
            ? {
                transcriptId: transcriptId.trim() || undefined,
                botId: botId.trim() || undefined,
              }
            : { transcript }),
          date: new Date(`${date || localDate()}T12:00:00Z`).toISOString(),
          useAI,
        }),
      });
      if (source === "meetstream" && botId.trim()) {
        try {
          if (localStorage.getItem(botStorageKey) === botId.trim()) {
            localStorage.removeItem(botStorageKey);
            localStorage.removeItem(botStorageKey + ":stopped");
          }
        } catch {
          // Import already succeeded.
        }
      }
      onImported(
        data.meeting,
        data.duplicate,
        source === "meetstream" ? data.audioChecked : undefined,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Import meeting"
      onClose={() => {
        if (!busy && !sending.current) onClose();
      }}
      wide
    >
      <form onSubmit={submit}>
        <div className="modal-body">
          <div className="source-tabs">
            <button
              type="button"
              className={source === "paste" ? "active" : ""}
              aria-pressed={source === "paste"}
              disabled={busy || sendingBot || !!botAction}
              onClick={() => {
                setSource("paste");
                setError("");
              }}
            >
              <FileText size={15} />
              Paste or upload
            </button>
            <button
              type="button"
              className={source === "meetstream" ? "active" : ""}
              aria-pressed={source === "meetstream"}
              disabled={busy || sendingBot || !!botAction}
              onClick={() => {
                setSource("meetstream");
                setError("");
              }}
            >
              <AudioLines size={15} />
              Send bot / MeetStream
            </button>
          </div>
          {source === "paste" ? (
            <div className="transcript-input">
              <label className="field">
                Transcript
                <textarea
                  required
                  rows={6}
                  placeholder={"[00:12] Alex: We decided to use cursor pagination."}
                  value={transcript}
                  maxLength={500000}
                  onChange={(e) => setTranscript(e.target.value)}
                />
              </label>
              <label className="upload-label">
                <ArrowDownToLine size={14} />
                Upload transcript
                <input
                  type="file"
                  aria-label="Upload transcript"
                  accept=".txt,.json,.md,text/plain,application/json"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (!file) return;
                    if (file.size > 500000) {
                      setError("Choose a file under 500 KB.");
                      return;
                    }
                    try {
                      setTranscript(await file.text());
                      setTitle((value) => value || file.name.replace(/\.[^.]+$/, "").slice(0, 200));
                      setError("");
                    } catch {
                      setError("Could not read this file. Try uploading it again.");
                    }
                  }}
                />
              </label>
            </div>
          ) : (
            <div>
              {connections.meetstream ? (
                <>
                  <label className="field">
                    Meeting link
                    <span className="field-hint">
                      Google Meet, Zoom, or Microsoft Teams
                    </span>
                    <input
                      inputMode="url"
                      value={meetingLink}
                      maxLength={2048}
                      onChange={(e) => setMeetingLink(e.target.value)}
                      placeholder="https://meet.google.com/…"
                      disabled={sendingBot || busy}
                    />
                  </label>
                  <BotSettingsFields settings={settings} onChange={setSettings}
                    meetingAgentEnabled={meetingAgentEnabled} disabled={busy || sendingBot} />
                  <button
                    type="button"
                    className="button"
                    disabled={
                      busy || sendingBot || !!botAction || !meetingLink.trim()
                    }
                    onClick={sendBot}
                  >
                    {sendingBot ? "Sending bot…" : "Send bot to meeting"}
                  </button>
                  <span className="field-hint bot-admission-hint">
                    Admit the bot from the meeting lobby to start recording.
                  </span>
                </>
              ) : (
                <p className="field-hint">
                  Connect MeetStream in{" "}
                  <Link
                    href="/workspace/integrations?app=meetstream"
                    onClick={onClose}
                  >
                    Integrations
                  </Link>{" "}
                  to send a bot or import by ID.
                </p>
              )}
              <section className="meetstream-bots" aria-label="Workspace bots">
                <div className="meetstream-bot-row">
                  <strong>Workspace bots</strong>
                  {(visibleBots.length > 0 || botListError) && (
                    <button type="button" className="text-button" onClick={() => setRefreshBots((value) => value + 1)}>
                      Refresh
                    </button>
                  )}
                </div>
                {botListError && <p className="field-hint" role="alert">{botListError}</p>}
                {!botListError && !visibleBots.length && <p className="field-hint">No bots waiting for a transcript or import.</p>}
                {visibleBots.length > 0 && <ul className="meetstream-bot-list">
                  {visibleBots.map((bot) => {
                    const status = botStatuses[bot.id];
                    const canStop = !bot.meetingId && status?.canStop;
                    const waitingForStop = Boolean(bot.stopRequestedAt &&
                      Date.now() - bot.stopRequestedAt < botStopRetryMs);
                    return (
                      <li className="meetstream-bot-row" key={bot.id}>
                        <div>
                          <strong>{bot.label}</strong>
                          <p className="field-hint">
                            {new Date(bot.createdAt).toLocaleString()} · {bot.id.slice(0, 8)}
                          </p>
                          <p className="field-hint" role="status">
                            {bot.meetingId ? "Imported"
                              : waitingForStop && (!status || canStop) ? "Stop requested · Waiting for bot to leave"
                              : status?.label ?? (connections.meetstream ? "Checking status…" : "MeetStream disconnected")}
                          </p>
                        </div>
                        {bot.meetingId ? (
                          <Link className="button" href={meetingPath(bot.meetingId)} onClick={onClose}>Open meeting</Link>
                        ) : status?.ready ? (
                          <button
                            type="button" className="button"
                            disabled={busy || sendingBot || !!botAction || bot.id === botId}
                            onClick={() => {
                              setBotId(bot.id);
                              setSelectedTrackedBotId(bot.id);
                              setTranscriptId("");
                              setError("");
                              titleRef.current?.focus();
                            }}
                          >
                            {bot.id === botId ? "Selected for import" : "Use transcript"}
                          </button>
                        ) : canStop && !waitingForStop && (
                          <button
                            type="button" className="button"
                            disabled={busy || sendingBot || !!botAction || !connections.meetstream}
                            onClick={() => updateBot("stop", bot.id)}
                          >
                            {botAction === `stop:${bot.id}` ? "Stopping bot…"
                              : bot.stopRequestedAt ? "Retry stop" : "Stop bot"}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>}
                {importedBotCount > 0 && (
                  <button type="button" className="text-button"
                    aria-expanded={showImported}
                    onClick={() => setShowImported((value) => !value)}>
                    {showImported ? "Hide imported bots" : `Show imported bots (${importedBotCount})`}
                  </button>
                )}
              </section>
              <details className="import-options">
                <summary>Import by ID</summary>
                <label className="field">
                  MeetStream bot ID
                  <input
                    value={botId}
                    onChange={(e) => {
                      setBotId(e.target.value);
                      setSelectedTrackedBotId("");
                    }}
                    placeholder="Paste bot ID"
                  />
                </label>
                {connections.meetstream && /^[a-zA-Z0-9_-]{1,200}$/.test(botId.trim())
                  && !selectedBot && (
                    <button type="button" className="button" disabled={busy || sendingBot || !!botAction}
                      onClick={() => updateBot("track", botId.trim())}>
                      {botAction ? "Tracking bot…" : "Track existing bot"}
                    </button>
                  )}
                <label className="field">
                  MeetStream transcript ID
                  <input
                    placeholder="Paste transcript ID"
                    value={transcriptId}
                    onChange={(e) => setTranscriptId(e.target.value)}
                  />
                </label>
              </details>
            </div>
          )}
          <label className="field import-title">
            Meeting title
            <input
              ref={titleRef}
              required
              maxLength={200}
              placeholder="e.g. API architecture review"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <details className="import-options">
            <summary>Meeting details</summary>
            <div className="form-grid">
              <label className="field">
                Project
                <input maxLength={100} value={project} placeholder="Unassigned"
                  onChange={(e) => setProject(e.target.value)} />
              </label>
              <label className="field">
                Meeting date
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </label>
            </div>
            {connections.ai && (
              <label className="checkbox-label">
                <input type="checkbox" checked={useAI} onChange={(e) => setUseAI(e.target.checked)} />
                <span>
                  Use Claude for extraction
                  <small>Sends the transcript to Anthropic.</small>
                </span>
              </label>
            )}
          </details>
          {error && (
            <div role="alert" className="form-error">
              {error}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button
            type="button"
            className="button"
            disabled={busy || sendingBot || !!botAction}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="button primary"
            disabled={busy || sendingBot || !!botAction || !readyToImport}
          >
            {busy ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <Sparkles size={15} />
            )}{" "}
            {busy
              ? "Preparing drafts…"
              : signedIn
                ? "Create meeting drafts"
                : "Sign in to import"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
