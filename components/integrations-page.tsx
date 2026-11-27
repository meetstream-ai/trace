"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  ExternalLink,
  KeyRound,
  Link2,
  LoaderCircle,
  Save,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import { requestJson } from "@/lib/client";
import {
  integrationCatalog,
  type IntegrationId,
  type IntegrationConfig,
  type IntegrationStates,
  type IntegrationState,
  type IntegrationOptions,
} from "@/lib/integration-catalog";
export function IntegrationsPage({
  states,
  speakers,
  onUpdated,
  renderIcon,
}: {
  states: Partial<IntegrationStates>;
  speakers: string[];
  onUpdated: () => Promise<void>;
  renderIcon: (id: string) => React.ReactNode;
}) {
  const router = useRouter(),
    query = useSearchParams();
  const selected =
    integrationCatalog.find((i) => i.id === query.get("app"))?.id || null;
  function setSelected(id: IntegrationId | null) {
    router.push(`/workspace/integrations${id ? `?app=${id}` : ""}`);
  }

  const info = integrationCatalog.find((x) => x.id === selected);
  return (
    <main className="integrations-page">
      <div className="page-heading">
        <div>
          <h1>Connect your workflow.</h1>
          <p>Bring the discussions to the places where the work happens.</p>
        </div>
        <span className="badge green">
          <ShieldCheck size={13} />
          Keys are encrypted on your server
        </span>
      </div>
      {selected && info ? (
        <>
          <button
            className="back-link integration-back"
            onClick={() => setSelected(null)}
          >
            <ArrowLeft size={14} />
            All integrations
          </button>
          <ConnectionForm
            key={selected}
            id={selected}
            state={states[selected]}
            speakers={speakers}
            renderIcon={renderIcon}
            onDone={async () => {
              await onUpdated();
              setSelected(null);
            }}
          />
        </>
      ) : (
        <>
          <div className="integration-notice">
            <Link2 size={20} />
            <div>
              <strong>Connect once. Review before every publish.</strong>
              <p>
                Paste a key, choose the destination, and match the owners. Your
                team stays in control.
              </p>
            </div>
          </div>
          <div className="integrations-grid">
            {integrationCatalog.map((i) => {
              const state = states[i.id];
              return (
                <article className="integration-card" key={i.id}>
                  <div className="integration-card-head">
                    {renderIcon(i.id)}
                    <span
                      className={`badge ${state?.configured ? "green" : "neutral"}`}
                    >
                      {state?.configured ? (
                        <>
                          <Check size={12} />
                          {state.verified ? "Access checked" : "Configured"}
                        </>
                      ) : (
                        "Not connected"
                      )}
                    </span>
                  </div>
                  <h2>
                    {i.name}
                    <span>{i.tag}</span>
                  </h2>
                  <p>{i.description}</p>
                  <button
                    className="button full"
                    onClick={() => setSelected(i.id)}
                  >
                    {state?.configured
                      ? "Manage connection"
                      : `Connect ${i.name}`}
                    <ArrowRight size={14} />
                  </button>
                  {state?.source === "environment" && (
                    <span className="connection-caption">
                      Using your environment settings
                    </span>
                  )}
                </article>
              );
            })}
          </div>
          <div className="integration-security">
            <ShieldCheck size={22} />
            <div>
              <strong>Small setup. Clear ownership.</strong>
              <p>
                Saved keys never return to the browser. Connecting a service
                does not create issues or send messages.
              </p>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
function ConnectionForm({
  id,
  state,
  speakers,
  onDone,
  renderIcon,
}: {
  id: IntegrationId;
  state?: IntegrationState;
  speakers: string[];
  onDone: () => Promise<void>;
  renderIcon: (id: string) => React.ReactNode;
}) {
  const info = integrationCatalog.find((x) => x.id === id)!;
  const [updatedAt] = useState(state?.updatedAt ?? "");
  const token = useRef<HTMLInputElement>(null);
  const webhookUrl = useRef<HTMLInputElement>(null);
  const apiKey = useRef<HTMLInputElement>(null);
  const [hasToken, setHasToken] = useState(false);
  const [config, setConfig] = useState<IntegrationState["config"]>({
      ...state?.config,
      model: state?.config.model || "claude-sonnet-5-5",
    }),
    [options, setOptions] = useState<IntegrationOptions | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [disconnecting, setDisconnecting] = useState(false);
  function field(key: keyof IntegrationState["config"], value: string) {
    setConfig((c) => ({ ...c, [key]: value }));
    if (key === "repository") setOptions(null);
    setError("");
  }
  function submittedConfig(): IntegrationConfig {
    return {
      ...config,
      token: token.current?.value,
      webhookUrl: webhookUrl.current?.value,
      apiKey: apiKey.current?.value,
    };
  }
  function clearCredentials() {
    for (const { current } of [token, webhookUrl, apiKey]) {
      if (current) current.value = "";
    }
    setHasToken(false);
  }
  async function discover() {
    setBusy(true);
    setError("");
    try {
      const data = await requestJson<{ options: IntegrationOptions }>(
        `/api/integrations/${id}`,
        {
          method: "POST",
          body: JSON.stringify({ action: "discover", config: submittedConfig() }),
        },
      );
      setOptions(data.options);
      const normalize = (s: string) =>
        s
          .normalize("NFKC")
          .toLocaleLowerCase()
          .replace(/[^\p{L}\p{N}]/gu, "");
      const matches = { ...config.assignees };
      for (const speaker of speakers) {
        if (!matches[speaker]) {
          const match = data.options.users.find(
            (u) => normalize(u.name) === normalize(speaker),
          );
          if (match) matches[speaker] = match.id;
        }
      }
      setConfig((c) => ({
        ...c,
        teamId:
          c.teamId ||
          (data.options.teams.length === 1 ? data.options.teams[0].id : ""),
        assignees: matches,
      }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await requestJson(`/api/integrations/${id}`, {
        method: "POST",
        body: JSON.stringify({ action: "save", config: submittedConfig(), updatedAt }),
      });
      clearCredentials();
      await onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  async function disconnect() {
    setDisconnecting(true);
    setError("");
    try {
      await requestJson(`/api/integrations/${id}?updatedAt=${encodeURIComponent(updatedAt)}`, { method: "DELETE" });
      clearCredentials();
      await onDone();
    } catch (e) {
      setError((e as Error).message);
      setDisconnecting(false);
    }
  }
  const mapping = id === "linear" || id === "github";
  return (
    <div className="connection-layout">
      <form className="connection-form" onSubmit={save} autoComplete="off">
        <div className="connection-heading">
          {renderIcon(id)}
          <div>
            <h2>
              {state?.configured ? "Manage" : "Connect"} {info.name}
            </h2>
            <p>{info.description}</p>
          </div>
        </div>
        {id === "webhook" && (
          <label className="field">
            HTTPS endpoint
            <input
              type="password"
              ref={webhookUrl}
              spellCheck={false}
              maxLength={2000}
              required={!state?.configured}
              onChange={() => setError("")}
              placeholder="Leave blank to keep the saved endpoint"
            />
          </label>
        )}
        <label className="field">
          {id === "webhook"
            ? "Signing secret"
            : id === "slack"
              ? "Incoming webhook URL"
              : id === "github"
                ? "Personal access token"
                : id === "jira" ? "Atlassian API token"
                  : id === "trello" ? "Trello token" : "API key"}
          <span className="field-hint">
            {state?.configured
              ? "A key is saved. Leave this blank to keep it."
              : "Your key is encrypted before it is saved."}
          </span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            maxLength={2000}
            required={!state?.configured}
            placeholder={
              state?.configured
                ? "Saved securely"
                : id === "slack"
                  ? "https://hooks.slack.com/services/…"
                  : "Paste your key"
            }
            ref={id === "slack" ? webhookUrl : token}
            onChange={(e) => {
              setHasToken(Boolean(e.currentTarget.value));
              setOptions(null);
              setError("");
            }}
          />
        </label>
        {id === "github" && (
          <label className="field">
            Repository
            <input
              required
              autoComplete="off"
              placeholder="owner/repository"
              maxLength={200}
              value={config.repository || ""}
              onChange={(e) => field("repository", e.target.value)}
            />
          </label>
        )}
        {id === "jira" && (
          <>
            <label className="field">Jira Cloud site
              <input required placeholder="https://your-team.atlassian.net" value={config.site || ""}
                onChange={(e) => field("site", e.target.value)} />
            </label>
            <label className="field">Atlassian email
              <input required type="email" value={config.email || ""} onChange={(e) => field("email", e.target.value)} />
            </label>
            <label className="field">Project key
              <input required placeholder="ENG" value={config.projectKey || ""} onChange={(e) => field("projectKey", e.target.value)} />
            </label>
            <label className="field">Issue type
              <input placeholder="Task" value={config.issueType || ""} onChange={(e) => field("issueType", e.target.value)} />
            </label>
          </>
        )}
        {id === "trello" && (
          <>
            <label className="field">Trello API key
              <input type="password" autoComplete="off" spellCheck={false} maxLength={200} required={!state?.configured} ref={apiKey}
                placeholder={state?.configured ? "Saved securely" : "Paste your API key"} onChange={() => setError("")} />
            </label>
            <label className="field">Destination list ID
              <input required maxLength={24} value={config.listId || ""} onChange={(e) => field("listId", e.target.value)} />
            </label>
          </>
        )}
        {id === "notion" && (
          <label className="field">
            Parent page link
            <input
              required
              type="text"
              placeholder="https://www.notion.so/…"
              value={config.parentPageId || ""}
              onChange={(e) => field("parentPageId", e.target.value)}
            />
          </label>
        )}
        {id === "ai" && (
          <label className="field">
            Model
            <input
              required
              maxLength={100}
              value={config.model || ""}
              onChange={(e) => field("model", e.target.value)}
            />
          </label>
        )}
        {mapping && (
          <>
            <button
              type="button"
              className="button"
              onClick={discover}
              disabled={
                busy ||
                (!hasToken && !state?.configured) ||
                (id === "github" && !config.repository)
              }
            >
              {busy ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <Link2 size={15} />
              )}{" "}
              {options
                ? "Reload accounts"
                : id === "linear"
                  ? "Load teams & members"
                  : "Load repository members"}
            </button>
            {options && (
              <div className="discovered-accounts">
                <div className="connection-verified">
                  <CheckCheck size={16} />
                  <span>Read access checked for {options.account}</span>
                </div>
                {id === "linear" && (
                  <label className="field">
                    Linear team
                    <select
                      required
                      value={config.teamId || ""}
                      onChange={(e) => field("teamId", e.target.value)}
                    >
                      <option value="">Choose a team</option>
                      {options.teams.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="mapping-heading">
                  <h3>Optional owner matching</h3>
                  <p>
                    Match an account to assign issues automatically, or leave it
                    blank and assign after creation.
                  </p>
                </div>
                <div className="owner-mapping">
                  {speakers.length ? (
                    speakers.map((speaker) => (
                      <label key={speaker}>
                        <span>{speaker}</span>
                        <select
                          aria-label={`Account for ${speaker}`}
                          value={config.assignees?.[speaker] || ""}
                          onChange={(e) => {
                            const assignees = { ...config.assignees };
                            if (e.target.value)
                              assignees[speaker] = e.target.value;
                            else delete assignees[speaker];
                            setConfig({ ...config, assignees });
                          }}
                        >
                          <option value="">Assign later</option>
                          {options.users.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))
                  ) : (
                    <p className="field-hint">
                      Import a meeting first, then return here to match its
                      speakers.
                    </p>
                  )}
                </div>
              </div>
            )}
          </>
        )}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="connection-form-footer">
          {state?.configured && (
            <button
              className="text-button disconnect-button"
              type="button"
              onClick={disconnect}
              disabled={busy || disconnecting}
            >
              {disconnecting ? (
                <LoaderCircle className="spin" size={14} />
              ) : (
                <Unplug size={14} />
              )}
              Disconnect
            </button>
          )}
          <button
            className="button primary"
            disabled={busy || disconnecting || (mapping && !options)}
          >
            {busy ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <Save size={15} />
            )}
            Save connection
          </button>
        </div>
      </form>
      <aside className="connection-guide">
        <KeyRound size={23} />
        <h3>A quick setup</h3>
        <p>{info.help}</p>
        <a className="button" href={info.url} target="_blank" rel="noreferrer">
          Open {info.name} settings
          <ExternalLink size={13} />
        </a>
        <div className="connection-guide-note">
          <ShieldCheck size={17} />
          <p>
            {mapping
              ? "Read access is checked here. Issue creation permissions are checked when you publish."
              : id === "slack"
                ? "The webhook determines the channel. Its first delivery confirms access."
                : "Approved meeting outputs are the only content sent to your team’s tools."}
          </p>
        </div>
      </aside>
    </div>
  );
}
