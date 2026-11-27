"use client";
import { linearStatusLabels } from "@/lib/linear-followups";
import { WorkspaceAdmin } from "./workspace-admin";
import { can, type Access } from "@/lib/access";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  AudioLines,
  Check,
  ChevronRight,
  CircleHelp,
  CircleCheck,
  Code2,
  Copy,
  Play,
  FileText,
  GitBranch,
  Layers3,
  Link2,
  ListTodo,
  LoaderCircle,
  Menu,
  MoreHorizontal,
  Settings2,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  adrMarkdown,
  evidenceUrl,
  meetingPreview,
  summaryMarkdown,
  time,
  type Meeting,
  type MeetingPreview,
  type Segment,
  type Discussion,
  type Action,
  type Delivery,
  type IntegrationStatus,
} from "@/lib/types";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  defaultPreferences,
  meetingSorts,
  type Preferences,
} from "@/lib/preferences";
import {
  workspaceRoute,
  meetingPath,
  type WorkspaceView,
} from "@/lib/navigation";
import { PreferencesPage } from "./preferences-pages";
import { IntegrationsPage } from "./integrations-page";
import { requestJson } from "@/lib/client";
import type { IntegrationStates } from "@/lib/integration-catalog";
import type { Correction } from "@/lib/review-corrections";
import { AppIcon, Avatar, Github, Modal, destinationName, download } from "./workspace/workspace-ui";
import { ImportModal } from "./workspace/import-meeting-dialog";
import { CorrectTurnModal, MergeDraftModal, EditDiscussionModal, EditActionModal } from "./workspace/draft-dialogs";
import { DraftCollection } from "./workspace/draft-collection";
import { MeetingList } from "./workspace/meeting-list";
import { useMeetingRecording } from "./workspace/meeting-recording";
import { MeetingDetail } from "./workspace/meeting-detail";
import { PublishModal } from "./workspace/publish-dialog";

type View = WorkspaceView;
type ModalState =
  | { type: "import"; source?: "paste" | "meetstream" }
  | { type: "editDiscussion"; meeting: Meeting; item: Discussion }
  | { type: "editAction"; meeting: Meeting; item: Action }
  | { type: "correctTurn"; meeting: Meeting; turn: Segment }
  | { type: "mergeDraft"; meeting: Meeting; item: Discussion | Action }
  | { type: "adr"; meeting: Meeting; item: Discussion }
  | { type: "publish"; meeting: Meeting; itemIds?: string[] }
  | { type: "removeProject"; name: string }
  | { type: "help" }
  | null;
const emptyStatus: IntegrationStatus = {
  jira: false,
  trello: false,
  linear: false,
  github: false,
  slack: false,
  webhook: false,
  notion: false,
  meetstream: false,
  ai: false,
};
type WorkspaceResponse = {
  access: Access;
  meetings: MeetingPreview[];
  deliveries: Delivery[];
  recordingMeetingIds: string[];
  meetingAgentEnabled: boolean;
  integrations: IntegrationStatus;
  signedIn: boolean;
  preferences: Preferences;
  integrationStates: IntegrationStates;
};

export default function Trace({ children }: { children?: ReactNode }) {
  const router = useRouter(),
    pathname = usePathname(),
    query = useSearchParams();
  const route = workspaceRoute(pathname || "/workspace/meetings");
  const view = route?.view || "meetings",
    selected = route?.meetingId || null;
  const segment = query.get("segment"),
    tab = [
      "overview",
      "discussions",
      "actions",
      "questions",
      "activity",
    ].includes(query.get("tab") || "")
      ? query.get("tab")!
      : "overview",
    filter = (view === "meetings"
      ? ["all", "review"]
      : ["all", "pending", "done"]
    ).includes(query.get("filter") || "")
      ? query.get("filter")!
      : "all",
    projectFilter = query.get("project") || "";
  const [preferences, setPreferences] =
      useState<Preferences>(defaultPreferences),
    [integrationDetails, setIntegrationDetails] = useState<
      Partial<IntegrationStates>
    >({});
  const requestedSort = query.get("sort") || "";
  const allowedSorts =
    view === "meetings"
      ? meetingSorts.map((x) => String(x.id))
      : view === "actions"
        ? ["newest", "oldest", "alphabetical", "owner", "priority", "due"]
        : ["newest", "oldest", "alphabetical"];
  const sort = allowedSorts.includes(requestedSort)
    ? requestedSort
    : view === "meetings"
      ? preferences.meetingSort
      : "newest";
  function updateQuery(key: string, value: string) {
    const next = new URLSearchParams(query.toString());
    if (value && !(key === "filter" && value === "all")) next.set(key, value);
    else next.delete(key);
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`, {
      scroll: false,
    });
  }
  const setTab = (value: string) =>
    updateQuery("tab", value === "overview" ? "" : value);

  const [meetings, setMeetings] = useState<MeetingPreview[]>([]),
    [detail, setDetail] = useState<Meeting>(),
    [detailError, setDetailError] = useState<{ id: string; message: string }>(),
    [detailAttempt, setDetailAttempt] = useState(0),
    [deliveries, setDeliveries] = useState<Delivery[]>([]),
    [meetingAgentEnabled, setMeetingAgentEnabled] = useState(false),
    [recordingMeetingIds, setRecordingMeetingIds] = useState<string[]>([]),
    [connections, setConnections] = useState(emptyStatus),
    [access, setAccess] = useState<Access>(),
    [search, setSearch] = useState(""),
    [modal, setModal] = useState<ModalState>(null),
    [toast, setToast] = useState(""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [signedIn, setSignedIn] = useState(false),
    [mobileNav, setMobileNav] = useState(false);
  function clearFilters() {
    setSearch("");
    router.replace(`/workspace/${view}`, { scroll: false });
  }
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!mobileNav) return;
    const frame = requestAnimationFrame(() =>
      document.querySelector<HTMLAnchorElement>(".sidebar .brand")?.focus(),
    );
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileNav(false);
    };
    const closeOnDesktop = () => {
      if (innerWidth > 760) setMobileNav(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnDesktop);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnDesktop);
      cancelAnimationFrame(frame);
      document.querySelector<HTMLButtonElement>(".mobile-menu")?.focus();
    };
  }, [mobileNav]);

  async function load() {
    setError("");
    try {
      const data = await requestJson<WorkspaceResponse>("/api/workspace");
      setMeetings(data.meetings);
      setDeliveries(data.deliveries);
      setRecordingMeetingIds(data.recordingMeetingIds);
      setMeetingAgentEnabled(data.meetingAgentEnabled);
      setAccess(data.access);
      setConnections(data.integrations);
      setSignedIn(data.signedIn);
      setPreferences(data.preferences);
      setIntegrationDetails(data.integrationStates);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k" && searchRef.current && !document.querySelector("dialog[open]")) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
    };
  }, []);
  useEffect(() => {
    setSearch("");
    setError("");
    setModal(null);
    setMobileNav(false);
  }, [pathname]);
  useEffect(() => {
    document.title = `${selected ? "Meeting" : view === "actions" ? "Action items" : view[0].toUpperCase() + view.slice(1)} · Trace`;
  }, [view, selected]);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(""), 4500);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  const current = detail?.id === selected ? detail : undefined;
  useEffect(() => {
    setDetail(undefined);
    setDetailError(undefined);
    if (!selected) return;
    const controller = new AbortController();
    requestJson<{ meeting: Meeting }>(`/api/meetings/${encodeURIComponent(selected)}`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
    }).then(({ meeting }) => {
      if (controller.signal.aborted) return;
      setDetail(meeting);
      setMeetings((previous) => previous.map((row) =>
        row.id === meeting.id && row.revision < meeting.revision ? meetingPreview(meeting) : row,
      ));
    }).catch((error: Error) => {
      if (!controller.signal.aborted) setDetailError({ id: selected, message: error.message });
    });
    return () => controller.abort();
  }, [selected, detailAttempt]);
  useEffect(() => {
    if (segment && current && !loading) {
      const turn = document.getElementById(`segment-${segment}`);
      turn?.focus({ preventScroll: true });
      turn?.scrollIntoView({ block: "center" });
    }
  }, [segment, current, loading]);
  const canPlay = (m: Pick<Meeting, "id">) => !!access && can(access.role, "review") &&
    recordingMeetingIds.includes(m.id);
  const recording = useMeetingRecording(current && !loading && canPlay(current) ? current.id : undefined);
  function navigate(next: View) {
    router.push(`/workspace/${next}`);
    setMobileNav(false);
  }
  function openMeeting(m: Pick<Meeting, "id">) {
    router.push(meetingPath(m.id));
  }
  function showEvidence(m: Meeting | MeetingPreview, id: string, play = true) {
    const path = meetingPath(m.id);
    const turn = ("segments" in m ? m.segments : m.turns).find((item) => item.id === id);
    if (play && turn && canPlay(m)) recording.play(m.id, turn.start);
    const next = new URLSearchParams(pathname === path ? query.toString() : "");
    next.set("segment", id);
    router.push(`${path}?${next}`, { scroll: false });
    if (pathname === path && segment === id) {
      const turn = document.getElementById(`segment-${id}`);
      turn?.focus({ preventScroll: true });
      turn?.scrollIntoView({ block: "center" });
    }
  }
  async function persist(m: Meeting, correction?: Correction | { kind: "refreshLinear" }) {
    if (!signedIn) {
      setError("Sign in to save your changes.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const outputs = [...m.actions, ...m.discussions];
      const updated = access && can(access.role, "review") && !correction
        ? { ...m, reviewed: outputs.length > 0 && outputs.every((item) => item.approved) } : m;
      const data = await requestJson<{ meeting: Meeting }>(`/api/meetings/${encodeURIComponent(m.id)}`, {
        method: correction ? "POST" : "PUT",
        body: JSON.stringify(correction ? { ...correction, revision: m.revision } : updated),
      });
      setMeetings((prev) =>
        prev.map((x) => (x.id === m.id ? meetingPreview(data.meeting) : x)),
      );
      setDetail((previous) => previous?.id === m.id ? data.meeting : previous);
      setModal((previous) => previous?.type === "publish" && previous.meeting.id === m.id
        ? { ...previous, meeting: data.meeting } : previous);
      return data.meeting;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function withMeeting(m: Meeting | MeetingPreview, run: (meeting: Meeting) => void | Promise<unknown>) {
    if ("segments" in m) {
      await run(m);
      return;
    }
    const path = location.pathname;
    setBusy(true);
    setError("");
    try {
      const { meeting } = await requestJson<{ meeting: Meeting }>(`/api/meetings/${encodeURIComponent(m.id)}`);
      if (location.pathname !== path) return;
      if (meeting.revision !== m.revision) {
        const preview = meetingPreview(meeting);
        setMeetings((previous) => previous.map((row) => row.id === m.id ? preview : row));
        setError("This meeting changed. Review the latest draft and try again.");
        return;
      }
      await run(meeting);
    } catch (error) {
      if (location.pathname === path) setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setToast("Copied to clipboard");
    } catch {
      setError("Clipboard access is unavailable. Use Download instead.");
    }
  }
  const projects = [
    ...new Set([
      preferences.defaultProject,
      ...meetings.map((meeting) => meeting.project),
    ]),
  ]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const canEdit = !!access && can(access.role, "edit");
  const canReview = !!access && can(access.role, "review");
  function mergeTargets(m: Meeting, item: Action | Discussion) {
    if ("linearFollowup" in item && item.linearFollowup) return [];
    const locked = new Set(deliveries.filter((delivery) => delivery.meetingId === m.id)
      .map((delivery) => delivery.itemId));
    if (!canReview || locked.has(item.id)) return [];
    return ("owner" in item ? m.actions : m.discussions)
      .filter((other) => other.id !== item.id && !locked.has(other.id) &&
        !("linearFollowup" in other && other.linearFollowup));
  }
  async function saveCorrection(m: Meeting, correction: Correction) {
    if (await persist(m, correction)) {
      setModal(null);
      setToast({
        action: "Action item added",
        discussion: "Discussion added",
        speaker: "Speaker label corrected",
        merge: "Drafts merged",
      }[correction.kind]);
    }
  }
  const discussionCount = meetings.reduce((count, meeting) => count + meeting.discussions.length, 0);
  const openActionCount = meetings.reduce((count, meeting) =>
    count + meeting.actions.filter((item) => !item.completed).length, 0);
  function refreshDelivery(delivery: Delivery) {
    setDeliveries((previous) => previous.map((item) => item.id === delivery.id ? delivery : item));
  }
  function evidence(m: Meeting | MeetingPreview, ids: string[]) {
    return (
      <div className="evidence-links">
        {ids.map((id) => {
          const s = ("segments" in m ? m.segments : m.turns).find((s) => s.id === id);
          return s ? (
            <button
              key={id}
              onClick={() => showEvidence(m, id)}
              title={`${canPlay(m) ? "Play" : "Read"} ${s.speaker} at ${time(s.start)}`}
            >
              {canPlay(m) ? <Play size={12} /> : <AudioLines size={12} />}
              {time(s.start)}
            </button>
          ) : null;
        })}
      </div>
    );
  }
  function discussionCard(m: Meeting | MeetingPreview, d: Discussion, compact = false) {
    return (
      <article className="discussion-card" key={`${m.id}-${d.id}`}>
        <div className="card-top">
          <span className={`badge ${d.approved ? "green" : "purple"}`}>
            <GitBranch size={11} />
            {d.approved ? "Accepted" : "Discussion draft"}
          </span>
          <button
            className="icon-button"
            title="Edit discussion"
            aria-label={`Edit ${d.title}`}
            disabled={busy || !canEdit || ((d.approved || m.reviewed) && !canReview)}
            onClick={() =>
              void withMeeting(m, (meeting) => setModal({ type: "editDiscussion", meeting, item: d }))
            }
          >
            <MoreHorizontal size={18} />
          </button>
        </div>
        <h3>{d.title}</h3>
        <p>{compact ? d.context.slice(0, 140) : d.context}</p>
        {evidence(m, d.evidence)}
        <div className="card-bottom">
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void withMeeting(m, (meeting) => setModal({ type: "adr", meeting, item: d }))}
          >
            <FileText size={14} />
            View ADR draft
          </button>
          <button
            disabled={busy || loading || !access || !can(access.role, "review")}
            className={`approve-button ${d.approved ? "accepted" : ""}`}
            onClick={() =>
              withMeeting(m, (meeting) => persist({
                ...meeting,
                reviewed: false,
                discussions: meeting.discussions.map((x) =>
                  x.id === d.id ? { ...x, approved: !x.approved } : x,
                ),
              }))
            }
          >
            <Check size={13} />
            {d.approved ? "Accepted" : "Accept discussion"}
          </button>
          {canReview && <button className="text-button" disabled={busy}
            onClick={() => { setError(""); void withMeeting(m, (meeting) => setModal({ type: "publish", meeting, itemIds: [d.id] })); }}>
            Publish discussion
          </button>}
        </div>
      </article>
    );
  }
  function actionRow(m: Meeting | MeetingPreview, a: Action) {
    const sent = deliveries.filter(
      (d) =>
        d.meetingId === m.id &&
        d.itemId === a.id &&
        d.status === "sent" &&
        d.url,
    );
    return (
      <article
        key={`${m.id}-${a.id}`}
        className={`action-row ${a.completed ? "complete" : ""}`}
      >
        {a.linearFollowup ? (
          <span className="task-check" title="Linear follow-up" aria-label="Linear follow-up"><Link2 size={12} /></span>
        ) : (
        <button
          className={`task-check ${a.completed ? "checked" : ""}`}
          aria-label={`${a.completed ? "Reopen" : "Complete"} ${a.title}`}
          title={a.completed ? "Mark task as incomplete" : "Mark task as done"}
          disabled={busy || loading || !canEdit}
          onClick={() =>
            withMeeting(m, (meeting) => persist({
              ...meeting,
              actions: meeting.actions.map((x) =>
                x.id === a.id ? { ...x, completed: !x.completed } : x,
              ),
            }))
          }
        >
          {a.completed && <Check size={12} />}
        </button>
        )}
        <div className="action-body">
          <button
            className="action-title"
            disabled={busy || !canEdit || ((a.approved || m.reviewed) && !canReview)}
            onClick={() =>
              void withMeeting(m, (meeting) => setModal({ type: "editAction", meeting, item: a }))
            }
          >
            {a.title}
          </button>
          {!current && (
            <button className="meeting-context" onClick={() => openMeeting(m)}>
              {m.title}
            </button>
          )}
          {evidence(m, a.evidence)}
          {a.linearFollowup?.kind === "issue" && (
            <span className="field-hint">
              <a href={a.linearFollowup.url} target="_blank" rel="noreferrer">{a.linearFollowup.identifier}</a>
              {" · "}{a.linearFollowup.status ? `Proposed status: ${linearStatusLabels[a.linearFollowup.status]}` : "Existing issue · no status change"}
            </span>
          )}
          {a.linearFollowup?.kind === "ambiguous" && (
            <p className="field-hint">Several Linear issues match. Verify the issue in Linear before acting.</p>
          )}
          {sent.map((d) => (
            <a
              className="external-link"
              key={d.id}
              href={d.url}
              target="_blank"
              rel="noreferrer"
            >
              {d.followupOf ? "Open Linear issue" : `Assign in ${destinationName(d.destination)}`} <ArrowRight size={12} />
            </a>
          ))}
          {canReview && a.linearFollowup?.kind !== "ambiguous" && <button className="text-button" disabled={busy}
            onClick={() => { setError(""); void withMeeting(m, (meeting) => setModal({ type: "publish", meeting, itemIds: [a.id] })); }}>
            {a.linearFollowup ? "Review Linear follow-up" : "Publish action"}
          </button>}
        </div>
        <span
          className={`priority ${a.priority.toLowerCase()}`}
          title={`${a.priority} priority`}
        >
          <i />
          <i />
          <i />
        </span>
        <span className="action-owner">
          {a.owner ? (
            <>
              <Avatar name={a.owner} size="xs" />
              <span>{a.owner.split(" ")[0]}</span>
            </>
          ) : (
            <span className="unassigned">Unassigned</span>
          )}
        </span>
        <button
          className={`mini-approve ${a.approved ? "accepted" : ""}`}
          disabled={busy || loading || !access || !can(access.role, "review")}
          aria-label={`${a.approved ? "Unapprove" : "Approve"} ${a.title}`}
          onClick={() =>
            withMeeting(m, (meeting) => persist({
              ...meeting,
              reviewed: false,
              actions: meeting.actions.map((x) =>
                x.id === a.id ? { ...x, approved: !x.approved } : x,
              ),
            }))
          }
        >
          <span>{a.approved ? "Approved" : "Approve"}</span>
        </button>
      </article>
    );
  }
  if (!route) return <>{children}</>;
  return (
    <div className="app-shell">
      {children}
      <aside id="sidebar" className={`sidebar ${mobileNav ? "open" : ""}`}>
        <a
          href="/workspace/meetings"
          onClick={(e) => {
            e.preventDefault();
            navigate("meetings");
          }}
          className="brand"
          aria-label="Trace home"
        >
          <span className="brand-mark">
            <i />
            <i />
            <i />
          </span>
          trace<span className="brand-dot">.</span>
        </a>
        <div className="workspace">
          <span className="workspace-avatar">
            <Code2 size={18} />
          </span>
          <div>
            <strong>{preferences.workspaceName}</strong>
            <span>Team workspace</span>
          </div>
          <span className="workspace-status" title="Workspace active" />
        </div>
        <span className="nav-label">Workspace</span>
        <nav aria-label="Main navigation">
          {(
            [
              {
                id: "meetings",
                label: "Meetings",
                icon: AudioLines,
                count: meetings.length,
              },
              {
                id: "discussions",
                label: "Discussions",
                icon: GitBranch,
                count: discussionCount,
              },
              {
                id: "actions",
                label: "Action items",
                icon: ListTodo,
                count: openActionCount,
              },
              { id: "integrations", label: "Integrations", icon: Layers3 },
            ] as const
          ).map((n) => (
            <Link
              key={n.id}
              href={`/workspace/${n.id}`}
              onClick={() => setMobileNav(false)}
              aria-current={view === n.id ? "page" : undefined}
              className={`nav-item ${view === n.id ? "active" : ""}`}
            >
              <n.icon size={18} />
              <span>{n.label}</span>
              {"count" in n && <span className="nav-count">{n.count}</span>}
            </Link>
          ))}
        </nav>
        {projects.length > 0 && (
          <div className="sidebar-projects">
            <span className="nav-label">Projects</span>
            {projects.map((project) => (
              <Link
                key={project}
                className={`project-nav ${projectFilter === project ? "selected" : ""}`}
                href={`/workspace/meetings?project=${encodeURIComponent(project)}`}
                onClick={() => setMobileNav(false)}
              >
                <span className="project-dot dot-0" />
                {project}
              </Link>
            ))}
          </div>
        )}
        <div className="sidebar-bottom">
          <button
            className="bottom-link"
            onClick={() => setModal({ type: "help" })}
          >
            <CircleHelp size={17} />
            Help & documentation
          </button>
          <Link
            className={`bottom-link ${view === "settings" ? "active" : ""}`}
            href="/workspace/settings"
            aria-current={view === "settings" ? "page" : undefined}
          >
            <Settings2 size={17} />
            Workspace settings
          </Link>
          <Link
            className="profile"
            href="/workspace/profile"
            aria-label="Open your profile"
          >
            <Avatar name={preferences.displayName} size="md" />
            <div>
              <strong>{preferences.displayName}</strong>
              <span>{preferences.email || "Your profile"}</span>
            </div>
            <ChevronRight size={13} />
          </Link>
        </div>
      </aside>
      {mobileNav && (
        <button
          className="nav-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileNav(false)}
        />
      )}
      <div className="app-main" inert={mobileNav}>
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              aria-expanded={mobileNav}
              aria-controls="sidebar"
              onClick={() => setMobileNav(!mobileNav)}
            >
              <Menu size={19} />
            </button>
            <span className="breadcrumb-icon">
              <Layers3 size={16} />
            </span>
            <Link href="/workspace/meetings">Workspace</Link>
            <ChevronRight size={13} />
            <Link
              href={`/workspace/${view}`}
              aria-current={!current ? "page" : undefined}
            >
              {view === "actions"
                ? "Action items"
                : view === "settings"
                  ? "Workspace settings"
                  : view[0].toUpperCase() + view.slice(1)}
            </Link>
            {current && (
              <>
                <ChevronRight size={13} />
                <strong>{current.title}</strong>
              </>
            )}
          </div>
          <div className="topbar-end">
            <span className="private-label">
              <ShieldCheck size={13} />
              Private workspace
            </span>
            <button
              className="icon-button"
              aria-label="Help"
              onClick={() => setModal({ type: "help" })}
            >
              <CircleHelp size={18} />
            </button>
            <Link href="/workspace/profile" aria-label="Open profile">
              <Avatar name={preferences.displayName} />
            </Link>
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button
              onClick={() => {
                setError("");
                if (!signedIn) location.href = "/login";
              }}
            >
              {signedIn ? "Dismiss" : "Sign in"}
              <X size={14} />
            </button>
          </div>
        )}
        {loading ? (
          <main className="loading-state">
            <LoaderCircle className="spin" size={24} />
            <p>Opening your workspace…</p>
          </main>
        ) : selected && !current && detailError?.id !== selected ? (
          <main className="loading-state">
            <LoaderCircle className="spin" size={24} />
            <p>Opening meeting…</p>
          </main>
        ) : current ? (
          <MeetingDetail
            meeting={current}
            tab={tab}
            segment={segment}
            deliveries={deliveries.filter((delivery) => delivery.meetingId === current.id)}
            busy={busy}
            canPlay={canPlay(current)}
            canReview={canReview}
            onBack={() => navigate("meetings")}
            onTabChange={setTab}
            onPublish={() => setModal({ type: "publish", meeting: current })}
            onRefreshLinear={canReview && connections.linear ? async () => {
              const refreshed = await persist(current, { kind: "refreshLinear" });
              if (refreshed) setToast(refreshed.revision === current.revision
                ? "No new Linear matches." : "Linear matches refreshed. Review the updated drafts.");
            } : undefined}
            onEvidence={(id) => showEvidence(current, id)}
            onCorrectTurn={(turn) => {
              setError("");
              setModal({ type: "correctTurn", meeting: current, turn });
            }}
            onDeliveryUpdate={refreshDelivery}
            renderDiscussion={(item) => discussionCard(current, item)}
            renderAction={(item) => actionRow(current, item)}
            audioPlayer={recording.player}
          />
        ) : selected ? (
          <main className="empty-state">
            <FileText size={32} />
            <h1>Could not open the meeting</h1>
            <p role="alert">{detailError?.message}</p>
            <button className="button" onClick={() => setDetailAttempt((attempt) => attempt + 1)}>
              Try again
            </button>
            <button className="button" onClick={() => navigate("meetings")}>
              Back to meetings
            </button>
          </main>
        ) : view === "meetings" ? (
          <MeetingList meetings={meetings} projects={projects} projectFilter={projectFilter}
            filter={filter} sort={sort} search={search} searchRef={searchRef} onSearch={setSearch}
            updateQuery={updateQuery} clearFilters={clearFilters}
            onImport={canEdit ? (source) => setModal({ type: "import", source }) : undefined}
            onRemoveProject={access && can(access.role, "manage")
              ? () => setModal({ type: "removeProject", name: projectFilter }) : undefined}
          />
        ) : view === "discussions" || view === "actions" ? (
          <DraftCollection view={view} meetings={meetings} filter={filter} sort={sort}
            search={search} searchRef={searchRef} onSearch={setSearch} updateQuery={updateQuery}
            clearFilters={clearFilters} onOpenMeeting={openMeeting}
            renderDiscussion={(meeting, item) => discussionCard(meeting, item, true)}
            renderAction={actionRow}
          />
        ) : view === "profile" || view === "settings" ? (
          access && can(access.role, "manage") ? (
            <div>
              <PreferencesPage
                key={view}
                kind={view}
                preferences={preferences}
                onSaved={setPreferences}
              />
              {view === "settings" && <WorkspaceAdmin access={access} />}
            </div>
          ) : (
            <main className="preferences-page">
              <h1>Workspace access</h1>
              <p>Your role is {access?.role}.</p>
              <button
                className="button"
                onClick={async () => {
                  try {
                    await requestJson("/api/auth/logout", { method: "POST" });
                    location.replace("/login");
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Sign out
              </button>
            </main>
          )
        ) : (
          <IntegrationsPage
            states={integrationDetails}
            speakers={Array.from(
              new Set(
                meetings.flatMap((m) => m.turns.map((s) => s.speaker)),
              ),
            )}
            onUpdated={load}
            renderIcon={(id) => <AppIcon id={id} />}
          />
        )}
      </div>
      {toast && (
        <div className="toast" role="status">
          <CircleCheck size={18} />
          {toast}
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {modal?.type === "removeProject" && (
        <Modal
          title={`Remove ${modal.name}?`}
          onClose={() => {
            if (!busy) setModal(null);
          }}
        >
          <div className="modal-body">
            <p>
              Meetings in this project will become unassigned. Their
              transcripts, discussions, and published links will stay available.
            </p>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="modal-footer">
            <button
              className="button"
              disabled={busy}
              onClick={() => setModal(null)}
            >
              Cancel
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await requestJson("/api/projects", {
                    method: "DELETE",
                    body: JSON.stringify({ name: modal.name }),
                  });
                  await load();
                  clearFilters();
                  setModal(null);
                  setToast("Project removed. Its meetings are now unassigned.");
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Remove project
            </button>
          </div>
        </Modal>
      )}
      {modal?.type === "import" && access && can(access.role, "edit") && (
        <ImportModal
          meetingAgentEnabled={meetingAgentEnabled}
          initialSource={modal.source ?? "paste"}
          defaultProject={projectFilter || preferences.defaultProject}
          botStorageKey={`trace:meetstream-bot:${access.workspace}:${access.actor}`}
          signedIn={signedIn}
          connections={connections}
          onClose={() => setModal(null)}
          onImported={(m, duplicate, audioChecked) => {
            setMeetings((prev) =>
              prev.some((x) => x.id === m.id) ? prev : [meetingPreview(m), ...prev],
            );
            setModal(null);
            openMeeting(m);
            if (m.source === "meetstream" || duplicate) void load();
            setToast(
              duplicate
                ? "This transcript is already in your workspace. No duplicate created."
                : m.source === "meetstream" && audioChecked === false
                  ? "Meeting imported with MeetStream’s timestamps. Recording check unavailable."
                  : "Meeting imported. Your drafts are ready for review.",
            );
          }}
        />
      )}
      {modal?.type === "correctTurn" && (
        <CorrectTurnModal
          meeting={modal.meeting}
          turn={modal.turn}
          busy={busy}
          error={error}
          onClose={() => { if (!busy) { setError(""); setModal(null); } }}
          onSave={(correction) => saveCorrection(modal.meeting, correction)}
          onCopy={() => copy(evidenceUrl(location.origin, modal.meeting, modal.turn.id))}
        />
      )}
      {modal?.type === "mergeDraft" && (
        <MergeDraftModal
          item={modal.item}
          targets={mergeTargets(modal.meeting, modal.item)}
          busy={busy}
          error={error}
          onClose={() => { if (!busy) { setError(""); setModal(null); } }}
          onSave={(keepId) => saveCorrection(modal.meeting, {
            kind: "merge", keepId, removeId: modal.item.id,
          })}
        />
      )}
      {modal?.type === "editDiscussion" && (
        <EditDiscussionModal
          error={error}
          meeting={modal.meeting}
          item={modal.item}
          busy={busy}
          onMerge={mergeTargets(modal.meeting, modal.item).length ? () => {
            setError("");
            setModal({ ...modal, type: "mergeDraft" });
          } : undefined}
          onClose={() => setModal(null)}
          onSave={async (d) => {
            const m = modal.meeting;
            if (
              await persist({
                ...m,
                reviewed: false,
                discussions: m.discussions.map((x) =>
                  x.id === d.id ? { ...d, approved: false } : x,
                ),
              })
            ) {
              setModal(null);
              setToast("Discussion saved");
            }
          }}
        />
      )}
      {modal?.type === "editAction" && (
        <EditActionModal
          error={error}
          meeting={modal.meeting}
          item={modal.item}
          busy={busy}
          onMerge={mergeTargets(modal.meeting, modal.item).length ? () => {
            setError("");
            setModal({ ...modal, type: "mergeDraft" });
          } : undefined}
          onClose={() => setModal(null)}
          onSave={async (a) => {
            const m = modal.meeting;
            if (
              await persist({
                ...m,
                reviewed: false,
                actions: m.actions.map((x) =>
                  x.id === a.id ? { ...a, approved: false } : x,
                ),
              })
            ) {
              setModal(null);
              setToast("Action item saved");
            }
          }}
        />
      )}
      {modal?.type === "adr" && (
        <Modal
          title="Architecture decision record"
          onClose={() => setModal(null)}
          wide
        >
          <div className="modal-body">
            <span className="badge purple">
              {modal.item.approved ? "Accepted" : "Proposed"} · Editable draft
            </span>
            <pre className="adr-preview">
              {adrMarkdown(
                modal.meeting,
                modal.item,
                typeof location !== "undefined" ? location.origin : "",
                (text) => text,
              )}
            </pre>
          </div>
          <div className="modal-footer">
            <button
              className="button"
              onClick={() =>
                copy(adrMarkdown(modal.meeting, modal.item, location.origin))
              }
            >
              <Copy size={14} />
              Copy Markdown
            </button>
            <button
              className="button"
              onClick={() => {
                const m = modal;
                setModal({
                  type: "editDiscussion",
                  meeting: m.meeting,
                  item: m.item,
                });
              }}
            >
              Edit draft
            </button>
            <button
              className="button primary"
              onClick={() =>
                download(
                  `${modal.item.id}.md`,
                  adrMarkdown(modal.meeting, modal.item, location.origin),
                )
              }
            >
              <ArrowDownToLine size={14} />
              Download ADR
            </button>
          </div>
        </Modal>
      )}
      {modal?.type === "publish" && access && can(access.role, "review") && (
        <PublishModal
          meeting={modal.meeting}
          connections={connections}
          deliveries={deliveries}
          onDeliveryUpdate={refreshDelivery}
          busy={busy}
          onClose={() => setModal(null)}
          itemIds={modal.itemIds}
          onToggle={async (itemId, approved) => {
            const m = modal.meeting;
            await persist({
              ...m, reviewed: false,
              actions: m.actions.map((item) => item.id === itemId ? { ...item, approved } : item),
              discussions: m.discussions.map((item) => item.id === itemId ? { ...item, approved } : item),
            });
          }}
          onPublish={async (destinations) => {
            setBusy(true);
            try {
              const m = modal.meeting;
              const data = await requestJson<{ sent: number; skipped: number; remaining: number; deliveries: Delivery[] }>("/api/publish", {
                method: "POST",
                body: JSON.stringify({
                  meetingId: m.id,
                  revision: m.revision,
                  destinations,
                  itemIds: modal.itemIds,
                }),
              });
              setDeliveries(data.deliveries);
              setToast(
                `${data.sent} outputs published. ${data.skipped} previous deliveries skipped.`,
              );
              return data;
            } catch (e) {
              throw e;
            } finally {
              setBusy(false);
            }
          }}
          onCopy={() =>
            copy(
              summaryMarkdown(
                {
                  ...modal.meeting,
                  actions: modal.meeting.actions.filter((item) => !modal.itemIds || modal.itemIds.includes(item.id)),
                  discussions: modal.meeting.discussions.filter((item) => !modal.itemIds || modal.itemIds.includes(item.id)),
                },
                location.origin,
              ),
            )
          }
        />
      )}
      {modal?.type === "help" && (
        <Modal
          title="A conversation, carried forward"
          onClose={() => setModal(null)}
        >
          <div className="modal-body help-body">
            <p>
              Trace turns engineering meetings into discussions, ADR drafts and
              owned action items. Every output links back to its source.
            </p>
            <ol>
              <li>
                <b>Bring the conversation.</b> Import a timestamped transcript
                or fetch one from MeetStream.
              </li>
              <li>
                <b>Make it accurate.</b> Check the evidence, edit the drafts and
                confirm owners.
              </li>
              <li>
                <b>Move the work forward.</b> Publish approved outputs to your
                connected tools, or export Markdown and JSON.
              </li>
            </ol>
            <div className="inline-note">
              <ShieldCheck size={17} />
              Rule-based extraction finds explicit agreements; configure Claude
              for contextual extraction.
            </div>
            <a
              className="button full"
              href="https://github.com/meetstream-ai/trace"
              target="_blank"
              rel="noreferrer"
            >
              <Github size={16} />
              Read the documentation
              <ArrowRight size={14} />
            </a>
          </div>
        </Modal>
      )}
    </div>
  );
}
