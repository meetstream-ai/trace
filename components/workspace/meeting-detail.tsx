import type { ReactNode } from "react";
import { ArrowDownToLine, ArrowLeft, ArrowRight, AudioLines, CalendarDays, CheckCheck, CircleHelp, Clock3, GitBranch, ListTodo, MoreHorizontal, Video } from "lucide-react";
import { time, type Action, type Discussion, type Delivery, type Meeting, type Segment } from "@/lib/types";
import { AppIcon, Avatar, dateLabel, destinationName, download } from "./workspace-ui";
import { IssueDeliveryRecovery } from "./publish-dialog";

export function MeetingDetail({
  meeting, tab, segment, deliveries, busy, canPlay, canReview, audioPlayer,
  onBack, onTabChange, onPublish, onRefreshLinear, onEvidence, onCorrectTurn,
  onDeliveryUpdate, renderDiscussion, renderAction,
}: {
  meeting: Meeting;
  tab: string;
  segment: string | null;
  deliveries: Delivery[];
  busy: boolean;
  canPlay: boolean;
  canReview: boolean;
  audioPlayer: ReactNode;
  onBack: () => void;
  onTabChange: (tab: string) => void;
  onPublish: () => void;
  onRefreshLinear?: () => void;
  onEvidence: (id: string) => void;
  onCorrectTurn: (turn: Segment) => void;
  onDeliveryUpdate: (delivery: Delivery) => void;
  renderDiscussion: (discussion: Discussion) => ReactNode;
  renderAction: (action: Action) => ReactNode;
}) {
  return (
    <main className="detail-page">
      <button className="back-link" onClick={onBack}>
        <ArrowLeft size={14} />
        All meetings
      </button>
      <div className="detail-heading">
        <div>
          <div className="heading-kicker">
            {meeting.project && (
              <span className="project-chip">
                <span className="project-dot dot-0" />
                {meeting.project}
              </span>
            )}
            {meeting.source === "sample" && (
              <span className="sample-label">Sample meeting</span>
            )}
          </div>
          <h1>{meeting.title}</h1>
          <div className="meeting-meta">
            <span>
              <CalendarDays size={14} />
              {dateLabel(meeting.date)},{" "}
              {new Date(meeting.date).getUTCFullYear()}
            </span>
            <span>
              <Clock3 size={14} />
              {Math.ceil(meeting.duration / 60)} min
            </span>
            <span>
              <Video size={14} />
              {meeting.platform}
            </span>
            <div className="avatar-stack">
              {Array.from(new Set(meeting.segments.map((s) => s.speaker)))
                .slice(0, 4)
                .map((n) => (
                  <Avatar name={n} key={n} size="xs" />
                ))}
            </div>
          </div>
        </div>
        <div className="detail-controls">
          <button
            className="button primary"
            disabled={!canReview}
            onClick={onPublish}
          >
            <CheckCheck size={16} />
            Publish outputs
          </button>
          {onRefreshLinear && (
            <button className="button" disabled={busy} onClick={onRefreshLinear}>
              Check Linear history
            </button>
          )}
        </div>
      </div>
      <div className="review-layout">
        <section className="review-content">
          {meeting.extraction === "rules" && (
            <details className="extraction-help">
              <summary>How drafts were extracted</summary>
              <p>Rules look for clear agreements such as “we decided to” or “we’re going with,” and concrete commitments such as “I will” or “I’m going to.” There is no confidence-score cutoff. Use the transcript turn menu to add anything missed.</p>
              <p>Discussions record an agreed choice and can be exported as an architecture decision record (ADR). Actions track follow-up work and can become issues. Approve selects work for publishing. The task checkbox tracks completion.</p>
            </details>
          )}
          {tab === "overview" && meeting.extraction === "ai" && meeting.summary.trim() && (
            <div className="review-summary">
              <h2>Summary</h2>
              <p>{meeting.summary}</p>
            </div>
          )}
          <div
            className="detail-tabs"
            role="group"
            aria-label="Meeting outputs"
          >
            {[
              "overview",
              "discussions",
              "actions",
              ...(meeting.questions.length || tab === "questions" ? ["questions"] : []),
              ...(deliveries.length > 0 || tab === "activity" ? ["activity"] : []),
            ].map((t) => (
              <button
                aria-pressed={tab === t}
                key={t}
                className={tab === t ? "active" : ""}
                onClick={() => onTabChange(t)}
              >
                {t === "overview" ? "Review" : t === "actions"
                  ? "Action items"
                  : t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
          {(tab === "overview" || tab === "discussions") && (
            <section className="output-section">
              <div className="section-heading">
                <h2>
                  <GitBranch size={17} />
                  Discussions
                  <span className="count-pill">
                    {meeting.discussions.length}
                  </span>
                </h2>
              </div>
              <div className="discussion-list">
                {meeting.discussions.map((d) => renderDiscussion(d))}
              </div>
              {!meeting.discussions.length && (
                <div className="empty-small">
                  No discussion drafts found. Review the transcript for
                  any missing context.
                </div>
              )}
            </section>
          )}
          {(tab === "overview" || tab === "actions") && (
            <section className="output-section">
              <div className="section-heading">
                <h2>
                  <ListTodo size={17} />
                  Action items
                  <span className="count-pill">
                    {meeting.actions.length}
                  </span>
                </h2>
                <button
                  className="text-button"
                  onClick={() =>
                    download(
                      "action-items.json",
                      JSON.stringify(meeting.actions, null, 2),
                      "application/json",
                    )
                  }
                >
                  <ArrowDownToLine size={14} />
                  Export
                </button>
              </div>
              <div className="actions-list">
                {meeting.actions.map((a) => renderAction(a))}
              </div>
              {!meeting.actions.length && (
                <div className="empty-small">
                  No explicit commitments found in this transcript.
                </div>
              )}
            </section>
          )}
          {(tab === "overview" || tab === "questions") &&
            meeting.questions.length > 0 && (
              <section className="output-section">
                <div className="section-heading">
                  <h2>
                    <CircleHelp size={17} />
                    Open questions
                  </h2>
                </div>
                {meeting.questions.map((q, i) => (
                  <div className="question-row" key={i}>
                    <span>?</span>
                    <p>{q}</p>
                  </div>
                ))}
              </section>
            )}
          {tab === "questions" && !meeting.questions.length && (
            <div className="empty-small">
              No open questions were extracted.
            </div>
          )}
          {tab === "activity" && (
            <section className="output-section">
              <div className="section-heading">
                <h2>Publishing activity</h2>
              </div>
              {deliveries.map((d) => (
                  <div key={d.id} className="delivery-row">
                    <AppIcon id={d.destination} />
                    <div>
                      <strong>{destinationName(d.destination)} · {
                        meeting.actions.find((item) => item.id === d.itemId)?.title ??
                        meeting.discussions.find((item) => item.id === d.itemId)?.title ?? "Meeting summary"
                      }</strong>
                      <p>
                        {d.status === "sent"
                          ? "Published"
                          : d.status === "pending"
                            ? "Publishing or awaiting reconciliation"
                            : "Check destination before retrying"}
                      </p>
                      {d.error && <small>{d.error}</small>}
                      {canReview && <IssueDeliveryRecovery delivery={d} revision={meeting.revision}
                        disabled={busy} onUpdate={onDeliveryUpdate} />}
                    </div>
                    {d.url && (
                      <a href={d.url} target="_blank" rel="noreferrer">
                        Open
                        <ArrowRight size={12} />
                      </a>
                    )}
                  </div>
                ))}
              {!deliveries.length && (
                <div className="empty-small">
                  No external actions yet. Approved outputs appear here
                  after publishing.
                </div>
              )}
            </section>
          )}
          <div className="review-footer">
            <button
              className="text-button"
              onClick={() =>
                download(
                  "meeting.json",
                  JSON.stringify(meeting, null, 2),
                  "application/json",
                )
              }
            >
              Export meeting
              <ArrowDownToLine size={13} />
            </button>
          </div>
        </section>
        <aside className="transcript-panel">
          <div className="transcript-title">
            <h2>
              <AudioLines size={17} />
              Source transcript
            </h2>
            <span className="transcript-duration">{time(meeting.duration)}</span>
          </div>
          {audioPlayer}
          <div className="transcript-scroll">
            {meeting.segments.map((s) => (
              <article
                tabIndex={-1}
                id={`segment-${s.id}`}
                key={s.id}
                className={`transcript-turn ${segment === s.id ? "highlight" : ""}`}
              >
                <div>
                  <Avatar name={s.speaker} size="xs" />
                  <strong title={s.previousSpeakers?.[0] && s.previousSpeakers[0] !== s.speaker
                    ? `Originally labeled ${s.previousSpeakers[0]}` : undefined}>{s.speaker}</strong>
                  <button
                    title={canPlay ? "Play from this timestamp" : "Read this transcript turn"}
                    onClick={() => onEvidence(s.id)}
                  >
                    {time(s.start)}
                  </button>
                  {canReview && (
                    <button
                      type="button"
                      className="turn-review-button"
                      aria-label={`Review transcript turn at ${time(s.start)}`}
                      title="Review this turn"
                      onClick={() => onCorrectTurn(s)}
                    >
                      <MoreHorizontal size={16} />
                    </button>
                  )}
                </div>
                <p>{s.text}</p>
              </article>
            ))}
          </div>
        </aside>
      </div>
    </main>
  );
}
