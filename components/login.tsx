"use client";
import { useState, type FormEvent } from "react";
import {
  ArrowRight,
  AudioLines,
  Eye,
  EyeOff,
  GitBranch,
  KeyRound,
  ListTodo,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";
export default function Login({ next }: { next: string }) {
  const [workspace, setWorkspace] = useState("local_seedy"),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [visible, setVisible] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          password,
          workspace,
          username: username.trim() || undefined,
        }),
      });
      const data = (await r.json()) as { error?: string };
      if (!r.ok)
        throw new Error(
          data.error || "Could not unlock the workspace. Try again.",
        );
      location.replace(next);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <section className="login-card">
        <a className="brand" href="/login" aria-label="Trace">
          <span className="brand-mark">
            <i />
            <i />
            <i />
          </span>
          trace<span className="brand-dot">.</span>
        </a>
        <div className="login-icon">
          <KeyRound size={22} />
        </div>
        <h1>
          A little focus.
          <br />A clear next step.
        </h1>
        <p>Sign in to your engineering workspace.</p>
        <form onSubmit={submit}>
          <label className="field">
            Workspace ID
            <input
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              required
            />
          </label>
          <label className="field">
            Username
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              placeholder="Optional for initial local setup"
            />
          </label>
          <label className="field" htmlFor="app-password">
            Password
            <div className="password-input">
              <input
                id="app-password"
                type={visible ? "text" : "password"}
                required
                autoFocus
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                maxLength={200}
              />
              <button
                type="button"
                className="icon-button"
                aria-label={visible ? "Hide password" : "Show password"}
                onClick={() => setVisible(!visible)}
              >
                {visible ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="button primary full" disabled={busy}>
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <ArrowRight size={16} />
            )}{" "}
            {busy ? "Opening workspace…" : "Open workspace"}
          </button>
        </form>
        <div className="login-foot">
          <ShieldCheck size={14} />
          <span>Access is scoped to your workspace.</span>
        </div>
      </section>
      <aside className="login-story">
        <div className="login-story-content">
          <span className="login-story-mark">
            <AudioLines size={33} />
          </span>
          <h2>
            Keep the context.
            <br />
            Carry the work forward.
          </h2>
          <p>
            Engineering conversations deserve more than another document nobody
            opens.
          </p>
          <div className="login-flow">
            <span>
              <AudioLines size={18} />A conversation with context
            </span>
            <span>
              <GitBranch size={18} />
              Discussions with evidence
            </span>
            <span>
              <ListTodo size={18} />A next step with an owner
            </span>
          </div>
        </div>
        <span className="login-powered">
          Built with MeetStream · Made for engineering teams
        </span>
      </aside>
    </main>
  );
}
