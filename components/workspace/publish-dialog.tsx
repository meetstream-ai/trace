import { useState } from "react";
import { ArrowRight, Copy, LoaderCircle, ShieldCheck, Sparkles } from "lucide-react";
import { linearStatusLabels } from "@/lib/linear-followups";
import { requestJson } from "@/lib/client";
import type { Delivery, Destination, IntegrationStatus, Meeting } from "@/lib/types";
import { AppIcon, Modal, destinationName } from "./workspace-ui";

export function IssueDeliveryRecovery({ delivery, revision, disabled, onUpdate }: {
  delivery: Delivery;
  revision: number;
  disabled: boolean;
  onUpdate: (delivery: Delivery) => void;
}) {
  const [result, setResult] = useState<{ message: string; canRetry: boolean }>();
  const [busy, setBusy] = useState<"check" | "retry" | "">("");
  if (delivery.destination !== "linear" && delivery.destination !== "github") return null;
  if (delivery.status === "sent" && !result) return null;
  const provider = destinationName(delivery.destination);
  async function recover(action: "check" | "retry") {
    setBusy(action);
    setResult(undefined);
    try {
      const data = await requestJson<{ message: string; canRetry: boolean; deliveries: Delivery[] }>(
        "/api/publish/recover", {
          method: "POST",
          body: JSON.stringify({ deliveryId: delivery.id, revision, action }),
        },
      );
      const updated = data.deliveries.find((item) => item.id === delivery.id);
      if (updated) onUpdate(updated);
      setResult({ message: data.message, canRetry: data.canRetry });
    } catch (error) {
      setResult({ message: (error as Error).message, canRetry: false });
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="issue-recovery">
      {result && <p role="status">{result.message}</p>}
      {delivery.status !== "sent" && (
        <div className="issue-recovery-actions">
          <button type="button" className="button" disabled={disabled || !!busy}
            onClick={() => recover("check")}>
            {busy === "check" ? "Checking…" : delivery.followupOf ? "Check Linear status" : `Check ${provider}`}
          </button>
          {(result?.canRetry || busy === "retry") && (
            <button type="button" className="button" disabled={disabled || !!busy}
              onClick={() => recover("retry")}>
              {busy === "retry" ? "Retrying…" : delivery.followupOf ? "Retry status update" : "Retry issue"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function PublishModal({
  meeting: m,
  connections,
  deliveries,
  busy,
  onClose,
  itemIds,
  onToggle,
  onPublish,
  onCopy,
  onDeliveryUpdate,
}: {
  meeting: Meeting;
  connections: IntegrationStatus;
  deliveries: Delivery[];
  busy: boolean;
  onClose: () => void;
  itemIds?: string[];
  onToggle: (itemId: string, approved: boolean) => Promise<void>;
  onPublish: (d: Destination[]) => Promise<{
    sent: number;
    skipped: number;
    remaining: number;
    deliveries: Delivery[];
  }>;
  onCopy: () => void;
  onDeliveryUpdate: (delivery: Delivery) => void;
}) {
  const [destinations, setDestinations] = useState<Destination[]>([]),
    [error, setError] = useState(""),
    [result, setResult] = useState<{
      sent: number;
      skipped: number;
      remaining: number;
      deliveries: Delivery[];
    } | null>(null);
  const items = [...m.discussions, ...m.actions].filter((item) => !itemIds || itemIds.includes(item.id));
  const approved = items.filter((item) => item.approved).length;
  const hasActions = items.some((item) => "owner" in item && !item.linearFollowup);
  const hasFollowups = items.some((item) => "owner" in item && item.linearFollowup?.kind === "issue");
  const hasDiscussions = items.some((item) => !("owner" in item));
  const related = deliveries.filter(
    (d) => d.meetingId === m.id && (!itemIds || itemIds.includes(d.itemId)),
  );
  return (
    <Modal
      title="Publish outputs"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="modal-body">
        <p className="modal-intro">Approve the drafts you want to send, then choose a destination. Issues can be assigned after creation.</p>
        <div className="publish-items">
          {items.map((item) => (
            <label className="publish-item" key={item.id}>
              <input type="checkbox" checked={item.approved} disabled={busy}
                onChange={(e) => onToggle(item.id, e.target.checked)} />
              <span><strong>{item.title}</strong><small>{"owner" in item && item.linearFollowup?.kind === "issue"
                ? `${item.linearFollowup.identifier} · ${item.linearFollowup.status ? linearStatusLabels[item.linearFollowup.status] : "Keep existing issue"}`
                : "owner" in item ? "Action item" : "Discussion"}</small></span>
            </label>
          ))}
        </div>
        {m.source === "sample" ? (
          <div className="inline-note">
            <Sparkles size={18} />
            <p>
              This is a fictional sample meeting. Try the review flow and export
              a summary. Import a real transcript to publish to your team.
            </p>
          </div>
        ) : (
          <>
            <h3 className="form-section-title">Choose where the work goes</h3>
            {(
              [
                "linear",
                "github",
                "jira",
                "trello",
                "slack",
                "notion",
                "webhook",
              ] as Destination[]
            ).filter((dest) => dest === "linear" ? hasActions || hasFollowups : ["github", "jira", "trello"].includes(dest) ? hasActions
              : dest === "notion" ? hasDiscussions : !itemIds).map((dest) => (
              <label
                className={`destination-row ${!connections[dest] ? "disabled" : ""}`}
                key={dest}
              >
                <AppIcon id={dest} />
                <span>
                  <strong>{destinationName(dest)}</strong>
                  <small>
                    {dest === "slack" || dest === "webhook"
                      ? "A summary of approved outputs"
                      : dest === "linear" && hasFollowups
                        ? hasActions ? "Create new issues and apply approved status updates" : "Apply approved updates to existing issues"
                      : dest === "notion"
                        ? "An ADR page for each accepted discussion"
                        : dest === "trello" ? "A card for each approved action"
                          : "An issue for each approved action · Assign later"}
                  </small>
                </span>
                {connections[dest] ? (
                  <input
                    type="checkbox"
                    checked={destinations.includes(dest)}
                    onChange={(e) =>
                      setDestinations((prev) =>
                        e.target.checked
                          ? [...prev, dest]
                          : prev.filter((x) => x !== dest),
                      )
                    }
                  />
                ) : (
                  <span className="muted">Not connected</span>
                )}
              </label>
            ))}
          </>
        )}
        <div className="publish-safety">
          <ShieldCheck size={14} />
          Previous deliveries are skipped. Uncertain outcomes are held for
          review.
        </div>
        {related.length > 0 && (
          <div className="publish-results">
            {related.map((d) => (
              <div key={d.id}>
                <span
                  className={`tiny-dot ${d.status === "sent" ? "green-dot" : "amber-dot"}`}
                />
                <div>
                  {destinationName(d.destination)} ·{" "}
                  {d.itemId === "summary"
                    ? "Meeting summary"
                    : m.actions.find((a) => a.id === d.itemId)?.title ||
                      m.discussions.find((a) => a.id === d.itemId)?.title}
                  <small>
                    {d.status === "sent"
                      ? "Published"
                      : d.status === "pending"
                        ? "Pending — check destination before any manual retry"
                        : d.error ||
                          "Outcome uncertain — reconcile before retrying"}
                  </small>
                  <IssueDeliveryRecovery delivery={d} revision={m.revision} disabled={busy}
                    onUpdate={onDeliveryUpdate} />
                </div>
                {d.url && (
                  <a href={d.url} target="_blank" rel="noreferrer">
                    {d.destination === "linear" || d.destination === "github" ? "Open & assign" : "Open"}
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
        {result && (
          <p role="status" className="success-text">
            {result.sent} published. {result.skipped} previous deliveries
            skipped.{" "}
            {result.remaining > 0 &&
              `${result.remaining} remain. Publish again to continue.`}
          </p>
        )}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button className="button" onClick={onCopy} disabled={!approved}>
          <Copy size={14} />
          Copy summary
        </button>
        {m.source !== "sample" && (
          <button
            className="button primary"
            disabled={busy || !destinations.length || !approved}
            onClick={async () => {
              setError("");
              try {
                setResult(await onPublish(destinations));
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            {busy ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <ArrowRight size={15} />
            )}
            Publish approved outputs
          </button>
        )}
      </div>
    </Modal>
  );
}
