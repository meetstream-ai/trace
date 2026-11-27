import { safeDeliveryLink } from "./delivery-link.ts";
import { type Action, type Segment, type LinearStatus } from "./types.ts";

export type TrackedIssue = {
  id: string;
  url: string;
  title: string;
  project: string;
};

const ignored = new Set(["a", "an", "the", "to", "for", "in", "on", "at", "of", "and", "our", "new"]);
export const linearStatusLabels: Record<LinearStatus, string> = {
  backlog: "Backlog", unstarted: "To do", started: "In progress",
  completed: "Done", canceled: "Canceled", duplicate: "Duplicate",
};
export function linearTitleKey(title: string) {
  const words = (title.normalize("NFKC").toLowerCase()
    .replace(/^(?:add|adding|implement|implementing|introduce|introducing|support|include)\s+/, "")
    .match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => !ignored.has(word));
  return words.length >= 2 ? [...new Set(words)].sort().join(" ") : "";
}
export function linearIssueIdentifier(url: string) {
  const safe = safeDeliveryLink(url, "linear");
  return safe ? new URL(safe).pathname.match(/\/issue\/([A-Z][A-Z0-9]*-\d+)(?:\/|$)/i)?.[1]?.toUpperCase() : undefined;
}

const states: [RegExp, LinearStatus][] = [
  [/^(?:i(?:['’]m| am) (?:working on|starting work on)|i (?:started working on|started implementing|have started working on))\s+(.+)$/iu, "started"],
  [/^i (?:finished|completed)(?: work on)?\s+(.+)$/iu, "completed"],
  [/^(.+?)\s+(?:is|has been)\s+(?:done|complete|completed|finished)$/iu, "completed"],
  [/^(.+?)\s+(?:is|has been)\s+(?:canceled|cancelled)$/iu, "canceled"],
  [/^(.+?)\s+is\s+(?:a )?duplicate$/iu, "duplicate"],
  [/^(.+?)\s+is\s+in progress$/iu, "started"],
  [/^(.+?)\s+is\s+(?:on the to[- ]?do list|ready to start|to[- ]?do)$/iu, "unstarted"],
  [/^(.+?)\s+is\s+(?:in|on) (?:the )?backlog$/iu, "backlog"],
];

export function matchLinearIssue(topic: string, project: string, history: TrackedIssue[]) {
  const references = [...new Set(topic.match(/\b[A-Z][A-Z0-9]*-\d+\b/g) ?? [])];
  if (references.length) {
    const referenced = history.filter((issue) => references.includes(linearIssueIdentifier(issue.url) ?? ""));
    return referenced.length === 1 && references.length > 1 ? [] : referenced;
  }
  const key = linearTitleKey(topic);
  if (!key) return [];
  return history.filter((issue) => issue.project.trim().toLowerCase() === project.trim().toLowerCase() &&
    key === linearTitleKey(issue.title));
}

export function extractLinearFollowups(
  actions: Action[], turns: Segment[], project: string, history: TrackedIssue[],
): Action[] {
  if (!history.length) return actions;
  const followups = new Map<string, Action>();
  function remember(topic: string, turn: Segment, status: LinearStatus | null, initial?: Action) {
    const matches = matchLinearIssue(topic, project, history);
    if (!matches.length) return initial;
    if (matches.length > 1) {
      const key = matches.map((issue) => issue.id).sort().join(",");
      if (!followups.has(key))
        followups.set(key, {
          ...draft(topic, turn), ...initial, linearFollowup: { kind: "ambiguous" },
        });
      return undefined;
    }
    const [issue] = matches;
    const previous = followups.get(issue.id);
    const evidence = [...new Set([...(previous?.evidence ?? []), turn.id])].slice(-20);
    followups.set(issue.id, {
      ...draft(issue.title, turn), ...initial, id: previous?.id ?? initial?.id ?? "linear-" + turn.id + "-" + followups.size,
      title: issue.title, evidence,
      linearFollowup: {
        kind: "issue", deliveryId: issue.id, url: issue.url,
        identifier: linearIssueIdentifier(issue.url)!, status: status ?? (previous?.linearFollowup?.kind === "issue" ? previous.linearFollowup.status : null),
      },
    });
    return undefined;
  }
  function draft(title: string, turn: Segment): Action {
    return {
      id: "linear-" + turn.id + "-" + followups.size, title: title.slice(0, 300),
      description: turn.text.slice(0, 4000),
      owner: turn.speaker === "Unknown speaker" ? "" : turn.speaker,
      due: "", priority: "Medium", evidence: [turn.id], approved: false, completed: false,
    };
  }
  const byTurn = new Map<string, Action[]>();
  for (const action of actions) {
    const evidence = action.evidence[0];
    const items = byTurn.get(evidence) ?? [];
    items.push(action);
    byTurn.set(evidence, items);
  }
  const newActions: Action[] = [];
  let context: { topic: string; turn: Segment } | undefined;
  for (const turn of turns) {
    for (const item of byTurn.get(turn.id) ?? []) {
      const unmatched = remember(item.title, turn, null, item);
      if (unmatched) newActions.push(unmatched);
      else if (matchLinearIssue(item.title, project, history).length === 1)
        context = { topic: item.title, turn };
    }
    for (const sentence of turn.text.match(/[^.!?]+[.!?]?/g) ?? []) {
      if (sentence.endsWith("?")) continue;
      const text = sentence.trim().replace(/[.!]$/, "")
        .replace(/^(?:(?:today|yesterday|quick update)[,:]?\s+)/i, "")
        .replace(/\s+(?:today|now|already)$/i, "");
      let hasStatus = false;
      for (const [pattern, status] of states) {
        const match = text.match(pattern);
        if (!match) continue;
        const reference = /^it$/i.test(match[1]) && context?.turn.speaker === turn.speaker &&
          turn.start - context.turn.start <= 45 ? context : undefined;
        if (reference) {
          const [issue] = matchLinearIssue(reference.topic, project, history);
          remember(reference.topic, turn, status);
          const draft = issue && followups.get(issue.id);
          if (draft && !draft.evidence.includes(reference.turn.id))
            draft.evidence = [reference.turn.id, ...draft.evidence].slice(-20);
        } else remember(match[1], turn, status);
        hasStatus = true;
        break;
      }
      if (!hasStatus) {
        const topic = text.replace(/^(?:about|regarding|on|quick update on|for)\s+/i, "");
        context = matchLinearIssue(topic, project, history).length === 1 ? { topic, turn } : undefined;
      }
    }
  }
  return [...followups.values(), ...newActions].slice(0, 200);
}
