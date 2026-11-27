import type { ReactNode, RefObject } from "react";
import { ArrowDownToLine, AudioLines, ChevronRight, Search } from "lucide-react";
import Link from "next/link";
import { evidenceUrl, type Action, type Discussion, type MeetingPreview } from "@/lib/types";
import { sortOutputs } from "@/lib/sorting";
import { download } from "./workspace-ui";

export function DraftCollection({
  view, meetings, filter, sort, search, searchRef, onSearch,
  updateQuery, clearFilters, onOpenMeeting, renderDiscussion, renderAction,
}: {
  view: "discussions" | "actions";
  meetings: MeetingPreview[];
  filter: string;
  sort: string;
  search: string;
  searchRef: RefObject<HTMLInputElement | null>;
  onSearch: (search: string) => void;
  updateQuery: (key: string, value: string) => void;
  clearFilters: () => void;
  onOpenMeeting: (meeting: MeetingPreview) => void;
  renderDiscussion: (meeting: MeetingPreview, item: Discussion) => ReactNode;
  renderAction: (meeting: MeetingPreview, item: Action) => ReactNode;
}) {
  const allDiscussions = sortOutputs(meetings.flatMap((meeting) =>
    meeting.discussions.map((item) => ({ meeting, item }))), sort);
  const allActions = sortOutputs(meetings.flatMap((meeting) =>
    meeting.actions.map((item) => ({ meeting, item }))), sort);
  const searchTerm = search.toLowerCase();
  const visibleDiscussions = allDiscussions.filter(({ item }) =>
    (filter === "all" || (filter === "done" ? item.approved : !item.approved)) &&
    `${item.title} ${item.context}`.toLowerCase().includes(searchTerm));
  const visibleActions = allActions.filter(({ item }) =>
    (filter === "all" || (filter === "done" ? item.completed : !item.completed)) &&
    `${item.title} ${item.owner}`.toLowerCase().includes(searchTerm));
  const empty = (view === "discussions" ? visibleDiscussions : visibleActions).length === 0;
  return (
    <main className="collection-page">
      <div className="page-heading">
        <div>
          <h1>{view === "discussions" ? "Discussions" : "Action items"}</h1>
          <p>
            {view === "discussions"
              ? "Review what the team agreed, check the evidence, and export an architecture decision record."
              : "Check who owns each follow-up, approve the draft, and publish it as an issue from its meeting."}
          </p>
        </div>
        <button
          className="button"
          onClick={() =>
            download(
              `${view}.json`,
              JSON.stringify(
                (view === "discussions" ? allDiscussions : allActions).map(
                  ({ meeting, item }) => ({
                    ...item,
                    meeting: {
                      id: meeting.id,
                      title: meeting.title,
                      date: meeting.date,
                      project: meeting.project,
                    },
                    evidence: item.evidence.map((segment) =>
                      evidenceUrl(location.origin, meeting, segment),
                    ),
                  }),
                ),
                null,
                2,
              ),
              "application/json",
            )
          }
        >
          <ArrowDownToLine size={15} />
          Export {view === "discussions" ? "discussions" : "action items"}
        </button>
      </div>
      <div className="list-toolbar collection-toolbar">
        <div className="filter-tabs">
          {[
            { id: "all", label: "All" },
            {
              id: "pending",
              label: view === "discussions" ? "Drafts" : "To do",
            },
            {
              id: "done",
              label: view === "discussions" ? "Accepted" : "Completed",
            },
          ].map((f) => (
            <button
              key={f.id}
              className={filter === f.id ? "active" : ""}
              onClick={() => updateQuery("filter", f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <label className="search-box">
          <Search size={15} />
          <input
            ref={searchRef}
            aria-label={`Search ${view}`}
            placeholder={`Search ${view === "actions" ? "action items" : "discussions"}…`}
            value={search}
            onChange={(e) => onSearch(e.target.value)}
          />
        </label>
      </div>
      <div className="collection-sort">
        <label>
          Sort
          <select
            aria-label={`Sort ${view === "actions" ? "action items" : "discussions"}`}
            value={sort}
            onChange={(e) => updateQuery("sort", e.target.value)}
          >
            {[
              { id: "newest", label: "Newest meeting" },
              { id: "oldest", label: "Oldest meeting" },
              { id: "alphabetical", label: "Title A–Z" },
              ...(view === "actions"
                ? [
                    { id: "priority", label: "Priority" },
                    { id: "owner", label: "Owner" },
                    { id: "due", label: "Due date" },
                  ]
                : []),
            ].map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {view === "discussions" ? (
        <div className="discussions-grid">
          {visibleDiscussions.map(({ meeting, item }) => (
            <div key={`${meeting.id}-${item.id}`}>
              <button
                className="collection-context"
                onClick={() => onOpenMeeting(meeting)}
              >
                <AudioLines size={13} />
                {meeting.title}
                <ChevronRight size={12} />
              </button>
              {renderDiscussion(meeting, item)}
            </div>
          ))}
        </div>
      ) : (
        <div className="actions-list collection-actions">
          {visibleActions.map(({ meeting, item }) => renderAction(meeting, item))}
        </div>
      )}
      {empty && (
        <div className="empty-state">
          <Search size={26} />
          <h3>
            No matching{" "}
            {view === "actions" ? "action items" : "discussions"}
          </h3>
          <p>
            {meetings.length
              ? "Try another search or clear your filters."
              : "Import a meeting transcript to start reviewing drafts."}
          </p>
          {meetings.length ? (
            <button className="button" onClick={clearFilters}>
              Clear filters
            </button>
          ) : (
            <Link className="button" href="/workspace/meetings">
              Go to meetings
            </Link>
          )}
        </div>
      )}
    </main>
  );
}
