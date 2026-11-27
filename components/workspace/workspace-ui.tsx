import { AudioLines, Hash, Link2, ListTodo, X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { integrationCatalog } from "@/lib/integration-catalog";
import type { Destination } from "@/lib/types";

export function destinationName(destination: Destination) {
  return integrationCatalog.find(({ id }) => id === destination)?.name ?? destination;
}

export function Github({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
    >
      <path d="M12 .8a11.2 11.2 0 0 0-3.54 21.83c.56.1.77-.24.77-.54v-2.08c-3.13.68-3.8-1.33-3.8-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.69.08-.69 1.13.08 1.73 1.16 1.73 1.16 1 .1 1.63 2.02 3.28 1.45.1-.72.39-1.22.71-1.5-2.5-.29-5.13-1.25-5.13-5.55 0-1.22.44-2.22 1.15-3-.12-.28-.5-1.42.11-2.96 0 0 .94-.3 3.08 1.15a10.7 10.7 0 0 1 5.6 0c2.14-1.45 3.08-1.15 3.08-1.15.61 1.54.23 2.68.11 2.96.72.78 1.15 1.78 1.15 3 0 4.31-2.63 5.26-5.14 5.54.4.35.76 1.03.76 2.08v3.08c0 .3.2.65.77.54A11.2 11.2 0 0 0 12 .8Z" />
    </svg>
  );
}
export function Avatar({
  name,
  size = "sm",
}: {
  name: string;
  size?: "sm" | "xs" | "md";
}) {
  const colors = ["lavender", "peach", "mint", "blue"];
  const color =
    colors[Array.from(name).reduce((n, c) => n + c.charCodeAt(0), 0) % 4];
  return (
    <span title={name} className={`avatar ${size} ${color}`}>
      {name
        .split(" ")
        .map((x) => x[0])
        .slice(0, 2)
        .join("")}
    </span>
  );
}
export function AppIcon({ id }: { id: string }) {
  return (
    <span className={`app-icon ${id}`}>
      {id === "github" ? (
        <Github size={22} />
      ) : id === "slack" ? (
        <Hash size={25} />
      ) : id === "jira" || id === "trello" ? (
        <ListTodo size={22} />
      ) : id === "notion" ? (
        <b>N</b>
      ) : id === "webhook" ? (
        <Link2 size={22} />
      ) : id === "meetstream" ? (
        <AudioLines size={23} />
      ) : id === "ai" ? (
        <span>✳</span>
      ) : (
        <span>◒</span>
      )}
    </span>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={`modal ${wide ? "wide" : ""}`}
      aria-labelledby="modal-title"
    >
      <div className="modal-head">
        <h2 id="modal-title">{title}</h2>
        <button
          aria-label="Close dialog"
          className="icon-button"
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function dateLabel(date: string) {
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
export function download(name: string, text: string, type = "text/markdown") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
