import { useGalleryStore } from "~/stores/galleryStore";
import { useEditorStore } from "~/stores/editorStore";
import { getAllSessions, getReferenceImagesByIds } from "~/lib/db";
import type { StoredEditorSession } from "~/types";
import { Clock, Plus, ChevronRight } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { formatRelativeDate } from "~/lib/util";
import { clsx } from "clsx";
import { closeMobileSidebar } from "./mobileSidebar";

export function RecentSessions() {
  const [sessions, setSessions] = useState<StoredEditorSession[]>([]);
  const [referenceThumbUrls, setReferenceThumbUrls] = useState<Record<string, string>>({});
  const referenceThumbUrlsRef = useRef<Record<string, string>>({});
  const [expanded, setExpanded] = useState(false);
  const currentSessionId = useEditorStore((s) => s.currentSessionId);
  const restoreSession = useEditorStore((s) => s.restoreSession);
  const clearForSessionRestore = useEditorStore((s) => s.clearForSessionRestore);
  const resetEditor = useEditorStore((s) => s.reset);
  const galleryItems = useGalleryStore((s) => s.items);

  useEffect(() => {
    void getAllSessions().then((all) => {
      setSessions(all.sort((a, b) => b.savedAt - a.savedAt));
    });
  }, [currentSessionId]);

  useEffect(() => {
    let cancelled = false;

    const externalRefSessions = sessions.filter(
      (session) => !session.sourceGalleryItemId && session.sourceReferenceId
    );
    const referenceIds = externalRefSessions
      .map((session) => session.sourceReferenceId)
      .filter((id): id is string => Boolean(id));

    if (referenceIds.length === 0) {
      const previous = referenceThumbUrlsRef.current;
      Object.values(previous).forEach((url) => URL.revokeObjectURL(url));
      referenceThumbUrlsRef.current = {};
      setReferenceThumbUrls({});
      return;
    }

    void getReferenceImagesByIds(referenceIds).then((references) => {
      if (cancelled) {
        references.forEach((reference) => URL.revokeObjectURL(reference.url));
        return;
      }

      const urlByReferenceId = new Map(
        references.map((reference) => [reference.id, reference.url])
      );
      const nextThumbUrls: Record<string, string> = {};

      for (const session of externalRefSessions) {
        const sourceReferenceId = session.sourceReferenceId;
        if (!sourceReferenceId) continue;
        const url = urlByReferenceId.get(sourceReferenceId);
        if (url) nextThumbUrls[session.id] = url;
      }

      const previous = referenceThumbUrlsRef.current;
      for (const [sessionId, url] of Object.entries(previous)) {
        if (nextThumbUrls[sessionId] !== url) URL.revokeObjectURL(url);
      }

      referenceThumbUrlsRef.current = nextThumbUrls;
      setReferenceThumbUrls(nextThumbUrls);
    });

    return () => {
      cancelled = true;
    };
  }, [sessions]);

  useEffect(() => {
    return () => {
      Object.values(referenceThumbUrlsRef.current).forEach((url) => URL.revokeObjectURL(url));
      referenceThumbUrlsRef.current = {};
    };
  }, []);

  const handleNewSession = () => {
    clearForSessionRestore();
    resetEditor();
    closeMobileSidebar();
  };

  const COLLAPSED_COUNT = 3;
  const visible = expanded ? sessions : sessions.slice(0, COLLAPSED_COUNT);
  const hasMore = sessions.length > COLLAPSED_COUNT;
  const isNewSession = !currentSessionId;

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-text-muted">
          <Clock className="h-4 w-4" />
        </span>
        <h2 className="text-text-tertiary text-xs font-medium tracking-wide uppercase">
          Recent Sessions
        </h2>
        {hasMore && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-text-muted hover:text-text-secondary ml-auto flex items-center gap-1 rounded text-xs transition-colors"
            aria-expanded={expanded}
          >
            <span>{expanded ? "Show less" : `+${sessions.length - COLLAPSED_COUNT} more`}</span>
            <ChevronRight
              className={`h-4 w-4 transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          </button>
        )}
      </div>

      <div className="space-y-1">
        {/* New Session button */}
        <button
          onClick={handleNewSession}
          className={clsx(
            "flex w-full items-center gap-2.5 rounded-lg p-2 text-left transition-colors",
            {
              "cursor-default border border-purple-500/40 bg-purple-500/10": isNewSession,
              "hover:bg-surface-overlay border border-transparent": !isNewSession,
            }
          )}
        >
          <div
            className={clsx(
              "flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md",
              {
                "bg-surface-overlay": !isNewSession,
                "bg-purple-500/10": isNewSession,
              }
            )}
          >
            <Plus
              className={clsx("h-6 w-6", {
                "text-text-muted": !isNewSession,
                "text-accent-muted": isNewSession,
              })}
            />
          </div>

          {/* Text */}
          <div className="min-w-0 flex-1">
            <p className="text-text-secondary truncate text-xs">New Session</p>
          </div>
        </button>

        {/* Past N sessions */}
        {visible.map((session) => {
          const isActive = session.id === currentSessionId;
          const galleryItem = session.sourceGalleryItemId
            ? galleryItems.find(
                (it) => it.id === session.sourceGalleryItemId && it.status === "completed"
              )
            : null;
          const thumbUrl =
            galleryItem?.status === "completed"
              ? galleryItem.thumbnailUrl
              : (referenceThumbUrls[session.id] ?? "");

          return (
            <button
              key={session.id}
              onClick={() => {
                closeMobileSidebar();
                void restoreSession(session.id);
              }}
              disabled={isActive}
              className={clsx(
                "flex w-full items-center gap-2.5 rounded-lg p-2 text-left transition-colors",
                {
                  "cursor-default border border-purple-500/40 bg-purple-500/10": isActive,
                  "hover:bg-surface-overlay border border-transparent": !isActive,
                }
              )}
            >
              {/* Thumbnail */}
              <div className="bg-surface-overlay h-9 w-9 shrink-0 overflow-hidden rounded-md">
                {thumbUrl ? (
                  <img src={thumbUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="h-full w-full" />
                )}
              </div>

              {/* Text */}
              <div className="min-w-0 flex-1">
                <p className="text-text-secondary truncate text-xs">
                  {session.sourcePrompt || "Untitled session"}
                </p>
                <p className="text-text-muted mt-0.5 text-[10px]">
                  {session.turns.length === 1 ? "1 turn" : `${session.turns.length} turns`}
                  {" · "}
                  {formatRelativeDate(session.savedAt)}
                  {isActive && <span className="text-accent-muted ml-1.5 font-medium">active</span>}
                </p>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
