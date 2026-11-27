import { useState } from "react";
import { Check, LoaderCircle } from "lucide-react";
import type { Correction } from "@/lib/review-corrections";
import { time, type Action, type Discussion, type Meeting, type Segment } from "@/lib/types";
import { Modal } from "./workspace-ui";

export function CorrectTurnModal({
  meeting, turn, busy, error, onClose, onSave, onCopy,
}: {
  meeting: Meeting;
  turn: Segment;
  busy: boolean;
  error: string;
  onClose: () => void;
  onCopy: () => void;
  onSave: (correction: Correction) => void;
}) {
  const [kind, setKind] = useState<"discussion" | "action" | "speaker">("discussion");
  const [title, setTitle] = useState("");
  const [speaker, setSpeaker] = useState(turn.speaker);
  const [owner, setOwner] = useState("");
  const participants = [...new Set(meeting.segments.map((item) => item.speaker))];
  return (
    <Modal title="Review transcript turn" onClose={onClose}>
      <form onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        const segmentId = turn.id;
        if (kind === "speaker") onSave({ kind, segmentId, speaker });
        else if (kind === "action") onSave({ kind, segmentId, title, owner });
        else onSave({ kind, segmentId, title });
      }}>
        <div className="modal-body">
          <blockquote className="correction-evidence">
            <strong>{turn.speaker} · {time(turn.start)}</strong>
            <p>{turn.text}</p>
          </blockquote>
          <label className="field">
            Correction
            <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="discussion">Add discussion</option>
              <option value="action">Add action item</option>
              <option value="speaker">Correct speaker</option>
            </select>
          </label>
          {kind === "speaker" ? (
            <label className="field">
              Speaker name
              <input required maxLength={120} value={speaker} onChange={(e) => setSpeaker(e.target.value)} />
              <span className="field-hint">Applies to this turn. Edit action owners separately.</span>
            </label>
          ) : (
            <label className="field">
              Title
              <input required maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
          )}
          {kind === "action" && (
            <label className="field">
              Owner
              <select value={owner} onChange={(e) => setOwner(e.target.value)}>
                <option value="">Unassigned</option>
                {participants.map((name) => <option key={name}>{name}</option>)}
              </select>
            </label>
          )}
          {error && <div className="form-error" role="alert">{error}</div>}
        </div>
        <div className="modal-footer">
          <button type="button" className="text-button" onClick={onCopy}>Copy evidence link</button>
          <button type="button" className="button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={busy || (kind === "speaker"
            ? !speaker.trim() || speaker.trim() === turn.speaker : !title.trim())}>
            {kind === "speaker" ? "Save speaker" : kind === "action" ? "Add action item" : "Add discussion"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function MergeDraftModal({
  item, targets, busy, error, onClose, onSave,
}: {
  item: Discussion | Action;
  targets: (Discussion | Action)[];
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: (keepId: string) => void;
}) {
  const [keepId, setKeepId] = useState("");
  return (
    <Modal title="Merge duplicate" onClose={onClose}>
      <form onSubmit={(e) => {
        e.preventDefault();
        if (!busy && keepId) onSave(keepId);
      }}>
        <div className="modal-body">
          <p className="modal-intro">Move the evidence from <strong>{item.title}</strong> into the draft you keep. Review the merged draft again before publishing.</p>
          <label className="field">
            Draft to keep
            <select required value={keepId} onChange={(e) => setKeepId(e.target.value)}>
              <option value="">Select a draft</option>
              {targets.map((target) => <option key={target.id} value={target.id}>{target.title}</option>)}
            </select>
          </label>
          {error && <div className="form-error" role="alert">{error}</div>}
        </div>
        <div className="modal-footer">
          <button type="button" className="button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={busy || !keepId}>Merge drafts</button>
        </div>
      </form>
    </Modal>
  );
}

export function EditDiscussionModal({
  item,
  meeting,
  onClose,
  onSave,
  onMerge,
  busy,
  error,
}: {
  item: Discussion;
  meeting: Meeting;
  onClose: () => void;
  onSave: (d: Discussion) => void;
  onMerge?: () => void;
  busy: boolean;
  error: string;
}) {
  const [draft, setDraft] = useState({ ...item });
  return (
    <Modal title="Edit discussion" onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(draft);
        }}
      >
        <div className="modal-body">
          {(["title", "context", "rationale", "consequences"] as const).map(
            (field) => (
              <label className="field" key={field}>
                {field[0].toUpperCase() + field.slice(1)}
                {field === "title" ? (
                  <input
                    required
                    maxLength={300}
                    value={draft[field]}
                    onChange={(e) =>
                      setDraft({ ...draft, [field]: e.target.value })
                    }
                  />
                ) : (
                  <textarea
                    rows={3}
                    maxLength={4000}
                    value={draft[field]}
                    onChange={(e) =>
                      setDraft({ ...draft, [field]: e.target.value })
                    }
                  />
                )}
              </label>
            ),
          )}
          <p className="field-hint">
            Evidence preserved:{" "}
            {item.evidence
              .map((id) =>
                time(meeting.segments.find((s) => s.id === id)!.start),
              )
              .join(", ")}
            . Saving returns this output to draft.
          </p>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="modal-footer">
          {onMerge && <button type="button" className="text-button" disabled={busy} onClick={onMerge}>Merge duplicate</button>}
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <Check size={15} />
            )}
            Save discussion
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function EditActionModal({
  item,
  meeting,
  onClose,
  onSave,
  onMerge,
  busy,
  error,
}: {
  item: Action;
  meeting: Meeting;
  onClose: () => void;
  onSave: (a: Action) => void;
  onMerge?: () => void;
  busy: boolean;
  error: string;
}) {
  const [draft, setDraft] = useState({ ...item });
  return (
    <Modal title="Edit action item" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(draft);
        }}
      >
        <div className="modal-body">
          <label className="field">
            Title
            <input
              required
              maxLength={300}
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          <label className="field">
            Description
            <textarea
              rows={4}
              maxLength={4000}
              value={draft.description}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
            />
          </label>
          <label className="field">
            Owner
            <select
              value={draft.owner}
              onChange={(e) => setDraft({ ...draft, owner: e.target.value })}
            >
              <option value="">Unassigned</option>
              {draft.owner && !meeting.segments.some((s) => s.speaker === draft.owner) && (
                <option value={draft.owner}>{draft.owner}</option>
              )}
              {Array.from(new Set(meeting.segments.map((s) => s.speaker))).map(
                (n) => (
                  <option key={n}>{n}</option>
                ),
              )}
            </select>
          </label>
          <div className="form-grid">
            <label className="field">
              Priority
              <select
                value={draft.priority}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    priority: e.target.value as Action["priority"],
                  })
                }
              >
                {["High", "Medium", "Low"].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </label>
            <label className="field">
              Due date
              <input
                type="date"
                value={draft.due}
                onChange={(e) => setDraft({ ...draft, due: e.target.value })}
              />
            </label>
          </div>
          <p className="field-hint">
            Leave the due date empty when no deadline was agreed.
          </p>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="modal-footer">
          {onMerge && <button type="button" className="text-button" disabled={busy} onClick={onMerge}>Merge duplicate</button>}
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            <Check size={15} />
            Save action item
          </button>
        </div>
      </form>
    </Modal>
  );
}
