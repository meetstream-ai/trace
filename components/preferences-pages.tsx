"use client";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import {
  ArrowRight,
  Check,
  LoaderCircle,
  LogOut,
  Save,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { requestJson } from "@/lib/client";
import { meetingSorts, type Preferences } from "@/lib/preferences";
export function PreferencesPage({
  kind,
  preferences,
  onSaved,
}: {
  kind: "profile" | "settings";
  preferences: Preferences;
  onSaved: (p: Preferences) => void;
}) {
  const [draft, setDraft] = useState(preferences),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false),
    [loggingOut, setLoggingOut] = useState(false);
  const changed = JSON.stringify(draft) !== JSON.stringify(preferences);
  const initials = draft.displayName
    .split(" ")
    .filter(Boolean)
    .map((x) => x[0])
    .slice(0, 2)
    .join("");
  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setSaved(false);
    setError("");
    try {
      const data = await requestJson<{ preferences: Preferences }>(
        "/api/preferences",
        { method: "PUT", body: JSON.stringify(draft) },
      );
      setDraft(data.preferences);
      onSaved(data.preferences);
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    setLoggingOut(true);
    setError("");
    try {
      await requestJson("/api/auth/logout", { method: "POST" });
      location.replace("/login");
    } catch (e) {
      setError((e as Error).message);
      setLoggingOut(false);
    }
  }
  return (
    <main className="preferences-page">
      <div className="page-heading">
        <div>
          <h1>{kind === "profile" ? "Your profile" : "Workspace settings"}</h1>
          <p>
            {kind === "profile"
              ? "Update the contact details shown for this workspace."
              : "Set the defaults for how your team works in Trace."}
          </p>
        </div>
      </div>
      <div className="preferences-layout">
        <section>
          <form className="settings-form" onSubmit={save}>
            <div className="settings-section-heading">
              <span className="settings-icon">
                {kind === "profile" ? (
                  <UserRound size={20} />
                ) : (
                  <ShieldCheck size={20} />
                )}
              </span>
              <div>
                <h2>
                  {kind === "profile"
                    ? "Workspace contact"
                    : "Workspace preferences"}
                </h2>
                <p>
                  {kind === "profile"
                    ? "These contact details are shared with workspace members."
                    : "Choose the default project and how meetings are sorted."}
                </p>
              </div>
            </div>
            {kind === "profile" ? (
              <>
                <div className="profile-preview">
                  <span className="profile-avatar-large">
                    {initials || "T"}
                  </span>
                  <div>
                    <strong>{draft.displayName}</strong>
                    <span>{draft.email || "Add an email below"}</span>
                  </div>
                </div>
                <label className="field">
                  Display name
                  <input
                    required
                    maxLength={80}
                    autoComplete="name"
                    value={draft.displayName}
                    onChange={(e) => {
                      setSaved(false);
                      setDraft({ ...draft, displayName: e.target.value });
                    }}
                  />
                </label>
                <label className="field">
                  Email address{" "}
                  <span className="field-hint">
                    Optional contact detail for this workspace.
                  </span>
                  <input
                    type="email"
                    maxLength={200}
                    autoComplete="email"
                    placeholder="you@company.com"
                    value={draft.email}
                    onChange={(e) => {
                      setSaved(false);
                      setDraft({ ...draft, email: e.target.value });
                    }}
                  />
                </label>
              </>
            ) : (
              <>
                <label className="field">
                  Workspace name
                  <input
                    required
                    maxLength={80}
                    value={draft.workspaceName}
                    onChange={(e) => {
                      setSaved(false);
                      setDraft({ ...draft, workspaceName: e.target.value });
                    }}
                  />
                </label>
                <label className="field">
                  Default project
                  <span className="field-hint">
                    Preselected when you import a meeting.
                  </span>
                  <input
                    maxLength={100}
                    value={draft.defaultProject}
                    onChange={(e) => {
                      setSaved(false);
                      setDraft({ ...draft, defaultProject: e.target.value });
                    }}
                  />
                </label>
                <label className="field">
                  Default meeting order
                  <select
                    value={draft.meetingSort}
                    onChange={(e) => {
                      setSaved(false);
                      setDraft({
                        ...draft,
                        meetingSort: e.target
                          .value as Preferences["meetingSort"],
                      });
                    }}
                  >
                    {meetingSorts.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            <div className="settings-form-footer">
              <span role="status">
                {saved ? (
                  <>
                    <Check size={14} />
                    Changes saved
                  </>
                ) : changed ? (
                  "You have unsaved changes."
                ) : (
                  "Your settings are up to date."
                )}
              </span>
              <button className="button primary" disabled={busy || !changed}>
                {busy ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <Save size={15} />
                )}
                Save changes
              </button>
            </div>
          </form>
          {kind === "profile" && (
            <section className="session-panel">
              <div>
                <h2>Session</h2>
                <p>End your current session on this browser.</p>
              </div>
              <button className="button" disabled={loggingOut} onClick={logout}>
                {loggingOut ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <LogOut size={15} />
                )}
                Sign out
              </button>
            </section>
          )}
        </section>
        {kind === "settings" && (
          <aside className="settings-aside">
            <h2>Access and integrations</h2>
            <p>Add members, assign roles, and review the audit log below.</p>
            <Link href="/workspace/integrations">
              Manage integrations <ArrowRight size={14} />
            </Link>
          </aside>
        )}
      </div>
    </main>
  );
}
