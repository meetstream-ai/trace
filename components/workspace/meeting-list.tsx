import { type RefObject } from "react";
import { AudioLines, FileText, Video, Search, ChevronRight, Check } from "lucide-react";
import Link from "next/link";
import { meetingPath } from "@/lib/navigation";
import { meetingSorts } from "@/lib/preferences";
import { sortMeetings } from "@/lib/sorting";
import type { MeetingPreview } from "@/lib/types";
import { dateLabel } from "./workspace-ui";

export function MeetingList({
  meetings, projects, projectFilter, filter, sort, search, searchRef, onSearch,
  updateQuery, clearFilters, onImport, onRemoveProject,
}: {
  meetings: MeetingPreview[];
  projects: string[];
  projectFilter: string;
  filter: string;
  sort: string;
  search: string;
  searchRef: RefObject<HTMLInputElement | null>;
  onSearch: (search: string) => void;
  updateQuery: (key: string, value: string) => void;
  clearFilters: () => void;
  onImport?: (source: "paste" | "meetstream") => void;
  onRemoveProject?: () => void;
}) {
  const projectMeetings = meetings.filter((meeting) => !projectFilter || meeting.project === projectFilter);
  const needsReview = projectMeetings.filter((meeting) => !meeting.reviewed).length;
  const searchTerm = search.toLowerCase();
  const visibleMeetings = sortMeetings(projectMeetings.filter((meeting) =>
    (filter !== "review" || !meeting.reviewed) &&
    `${meeting.title} ${meeting.project} ${meeting.summary}`.toLowerCase().includes(searchTerm)
  ), sort);
  return (
    <main className="dashboard meetings-page">
      <div className="page-heading">
        <div>
          <h1>Meetings</h1>
          <p>
            Import a transcript to draft discussions and follow-up tasks
            with links to what was said.
          </p>
        </div>
        {onImport && (
          <div className="meeting-entry-actions">
            <button className="button" onClick={() => onImport("paste")}>
              <FileText size={16} /> Import transcript
            </button>
            <button className="button primary" onClick={() => onImport("meetstream")}>
              <Video size={16} /> Send bot to meeting
            </button>
          </div>
        )}
      </div>
      {projectFilter && (
        <div className="project-context">
          <strong>{projectFilter}</strong>
          {onRemoveProject && projects.includes(projectFilter) && (
              <button
                className="button"
                onClick={onRemoveProject}
              >
                Remove project
              </button>
            )}
        </div>
      )}
      <section className="meetings-section">
        <div className="list-toolbar meetings-toolbar">
          <div className="filter-tabs" role="group" aria-label="Review status">
            {[
              { id: "all", label: "All meetings" },
              { id: "review", label: "Needs review" },
            ].map((f) => (
              <button
                key={f.id}
                className={filter === f.id ? "active" : ""}
                aria-pressed={filter === f.id}
                onClick={() => updateQuery("filter", f.id)}
              >
                {f.label}
                {f.id === "review" && needsReview > 0 && (
                  <span>{needsReview}</span>
                )}
              </button>
            ))}
          </div>
          <label className="search-box">
            <Search size={15} />
            <input
              ref={searchRef}
              aria-label="Search meetings"
              placeholder="Search meetings…"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
            />
            <kbd>⌘ K</kbd>
          </label>
          <div className="meeting-list-controls">
            <label>
              <select
                aria-label="Filter by project"
                value={projectFilter}
                onChange={(e) => updateQuery("project", e.target.value)}
              >
                <option value="">All projects</option>
                {[...new Set([...projects, projectFilter])]
                  .filter(Boolean)
                  .map((project) => (
                    <option key={project}>{project}</option>
                  ))}
              </select>
            </label>
            <label>
              <select
                aria-label="Sort meetings"
                value={sort}
                onChange={(e) => updateQuery("sort", e.target.value)}
              >
                {meetingSorts.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <div className="meeting-list">
          {visibleMeetings.map((m) => (
            <Link
              className="meeting-row"
              key={m.id}
              href={meetingPath(m.id)}
            >
              <span className="meeting-icon">
                <AudioLines size={18} aria-hidden="true" />
              </span>
              <span className="meeting-info">
                <strong>{m.title}</strong>
                <span>
                  {m.project && (
                    <>
                      <span className="project-dot dot-0" />
                      {m.project}
                      <i />
                    </>
                  )}
                  {dateLabel(m.date)}
                  <i />
                  {Math.ceil(m.duration / 60)} min
                </span>
              </span>
              <span className="row-outputs">
                <span>
                  {m.discussions.length} {m.discussions.length === 1 ? "discussion" : "discussions"}
                </span>
                <span>
                  {m.actions.length} {m.actions.length === 1 ? "action" : "actions"}
                </span>
              </span>
              <span
                className={`meeting-status ${m.reviewed ? "reviewed" : "needs-review"}`}
              >
                {m.reviewed ? (
                  <Check size={11} />
                ) : (
                  <span className="tiny-dot" />
                )}
                {m.reviewed ? "Reviewed" : "Needs review"}
              </span>
              <ChevronRight size={15} className="row-chevron" aria-hidden="true" />
            </Link>
          ))}
        </div>
        {!visibleMeetings.length && (
          <div className="empty-state">
            <AudioLines size={26} />
            <h3>{meetings.length ? "No matching meetings" : "No meetings yet"}</h3>
            <p>{meetings.length
              ? "Try another search or clear your filters."
              : "Import a transcript to draft discussions and follow-up tasks."}</p>
            {meetings.length > 0 && (
              <button className="button" onClick={clearFilters}>
                Clear filters
              </button>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
