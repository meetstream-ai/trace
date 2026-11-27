"use client";

import { useEffect, useState, type FormEvent } from "react";
import { roles, type Access, type Role } from "@/lib/access";
import { requestJson } from "@/lib/client";

type AdminData = {
  members: { id: string; username: string; role: Role }[];
  events: {
    actor: string;
    action: string;
    target: string;
    createdAt: number;
  }[];
};

export function WorkspaceAdmin({ access }: { access: Access }) {
  const [data, setData] = useState<AdminData>();
  const [mode, setMode] = useState("member");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setData(await requestJson<AdminData>("/api/admin"));
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await requestJson<{ signInRequired: boolean }>(
        "/api/admin",
        {
          method: "POST",
          body: JSON.stringify({ ...values, action: mode }),
        },
      );
      form.reset();
      if (result.signInRequired) {
        location.replace("/login?next=/workspace/settings");
        return;
      }
      setMessage(
        mode === "workspace"
          ? `Workspace ${values.id} created. Sign out to open it with the new admin account.`
          : "Member created.",
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError("");
    try {
      await requestJson("/api/admin", {
        method: "POST",
        body: JSON.stringify({ action: "remove", id }),
      });
      await load();
      setMessage("Member access revoked.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="preferences-page workspace-admin">
      <section className="admin-section">
        <h2>Members</h2>
        <p>
          Workspace ID <code>{access.workspace}</code>
        </p>
        {access.actor === "local-bootstrap" && (
          <p>
            Create a named admin to finish setup and retire password-only
            sign-in.
          </p>
        )}
        {!data ? (
          <p>Loading members…</p>
        ) : data.members.length ? (
          <ul className="admin-rows">
            {data.members.map((member) => (
              <li key={member.id}>
                <div>
                  <strong>{member.username}</strong>
                  <br />
                  <small>
                    {member.role}
                    {member.id === access.actor ? " · You" : ""}
                  </small>
                </div>
                {member.id !== access.actor && (
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(`Revoke access for ${member.username}?`)
                      )
                        void remove(member.id);
                    }}
                  >
                    Revoke access
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p>No named accounts yet.</p>
        )}
      </section>
      <section className="admin-section">
        <h2>Add access</h2>
        <p>
          Create an account in this workspace or set up a separate workspace
          with its own admin.
        </p>
        <label className="field">
          Account destination
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="member">Workspace member</option>
            <option value="workspace">New workspace</option>
          </select>
        </label>
        <form className="settings-form" onSubmit={submit}>
          {mode === "workspace" && (
            <>
              <label className="field">
                Workspace ID
                <input name="id" required pattern="[a-z0-9][a-z0-9-]{2,63}" />
              </label>
              <label className="field">
                Workspace name
                <input name="name" required maxLength={100} />
              </label>
            </>
          )}
          <label className="field">
            Username
            <input name="username" required maxLength={80} autoComplete="off" />
          </label>
          <label className="field">
            Password
            <input
              name="password"
              type="password"
              required
              minLength={12}
              maxLength={200}
              autoComplete="new-password"
            />
          </label>
          {mode === "member" && (
            <label className="field">
              Role
              <select
                name="role"
                defaultValue={
                  access.actor === "local-bootstrap" ? "admin" : "editor"
                }
              >
                {(access.actor === "local-bootstrap" ? ["admin"] : roles).map(
                  (role) => (
                    <option key={role} value={role}>
                      {role[0].toUpperCase() + role.slice(1)}
                    </option>
                  ),
                )}
              </select>
            </label>
          )}
          <button className="button primary" disabled={busy}>
            {mode === "workspace" ? "Create workspace" : "Create member"}
          </button>
        </form>
        {message && <p role="status">{message}</p>}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </section>
      <section className="admin-section">
        <h2>Recent audit events</h2>
        <p>Review account activity, workspace changes, and delivery results.</p>
        {!data ? (
          <p>Loading activity…</p>
        ) : data.events.length ? (
          <ol className="admin-rows admin-events">
            {data.events.map((event, i) => (
              <li key={i}>
                <div>
                  <strong>{auditLabel(event.action)}</strong>
                  <br />
                  <small>
                    {data.members.find((member) => member.id === event.actor)
                      ?.username ??
                      (event.actor === "local-bootstrap"
                        ? "Initial setup"
                        : "Former member")}
                  </small>
                  {event.target !== access.workspace && (
                    <small> · {event.target}</small>
                  )}
                </div>
                <time dateTime={new Date(event.createdAt).toISOString()}>
                  {new Date(event.createdAt).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </time>
              </li>
            ))}
          </ol>
        ) : (
          <p>No activity recorded yet.</p>
        )}
      </section>
    </div>
  );
}

const auditLabels: Record<string, string> = {
  "session.signed_in": "Signed in",
  "session.signed_out": "Signed out",
  "workspace.created": "Workspace created",
  "workspace.settings_changed": "Settings updated",
  "member.created": "Member added",
  "member.removed": "Member access revoked",
  "meeting.imported": "Meeting imported",
  "meetstream.bot.sent": "Meeting bot sent",
  "meetstream.bot.stop_requested": "Meeting bot stop requested",
  "meetstream.bot.tracked": "Existing meeting bot tracked",
  "meeting.edited": "Meeting edited",
  "meeting.corrected": "Meeting corrected",
  "meeting.review_changed": "Meeting review updated",
  "integration.saved": "Integration updated",
  "integration.disconnected": "Integration disconnected",
  "project.removed": "Project removed",
  "delivery.claimed": "Delivery started",
  "delivery.sent": "Delivery sent",
  "delivery.recovered": "Existing issue linked",
  "delivery.retried": "Issue delivery retried",
  "delivery.uncertain": "Delivery needs checking",
};

function auditLabel(action: string) {
  const [event, destination] = action.split(":");
  const label = auditLabels[event] ?? event;
  return destination ? `${label} (${destination})` : label;
}
