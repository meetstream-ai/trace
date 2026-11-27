import type { Meeting, Action } from "./types.ts";
export function sortMeetings<T extends Pick<Meeting, "title" | "id" | "date" | "duration" | "reviewed">>(meetings: T[], sort: string) {
  return [...meetings].sort((a, b) => {
    const fallback = a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
    if (sort === "alphabetical") return fallback;
    if (sort === "duration") return b.duration - a.duration || fallback;
    if (sort === "oldest") return a.date.localeCompare(b.date) || fallback;
    if (sort === "review")
      return (
        Number(a.reviewed) - Number(b.reviewed) ||
        b.date.localeCompare(a.date) ||
        fallback
      );
    return b.date.localeCompare(a.date) || fallback;
  });
}
export function sortOutputs<T extends { title: string }, M extends Pick<Meeting, "date">>(
  rows: { meeting: M; item: T }[],
  sort: string,
) {
  return [...rows].sort((a, b) => {
    const fallback = a.item.title.localeCompare(b.item.title);
    if (sort === "alphabetical") return fallback;
    const x = a.item as unknown as Action,
      y = b.item as unknown as Action;
    if (sort === "owner")
      return (
        (x.owner || "\uffff").localeCompare(y.owner || "\uffff") || fallback
      );
    if (sort === "priority") {
      const rank = { High: 0, Medium: 1, Low: 2 };
      return (rank[x.priority] ?? 3) - (rank[y.priority] ?? 3) || fallback;
    }
    if (sort === "due")
      return (x.due || "9999").localeCompare(y.due || "9999") || fallback;
    return (
      (sort === "oldest"
        ? a.meeting.date.localeCompare(b.meeting.date)
        : b.meeting.date.localeCompare(a.meeting.date)) || fallback
    );
  });
}
