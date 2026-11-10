import { useCallback, useState } from "react";
import { callTextModel } from "~/lib/textModel";
import { useSettingsStore } from "~/stores/settingsStore";

function notifyImproveComplete() {
  if (!useSettingsStore.getState().desktopNotificationsEnabled) return;
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  if (!document.hidden && document.hasFocus()) return;

  new Notification("Prismix", {
    body: "Text rewrite complete.",
    tag: "prismix-improve-text-complete",
  });
}

export function useImproveText({
  systemPrompt,
  text,
  setText,
  getImages,
  baseText: controlledBaseText,
  setBaseText: controlledSetBaseText,
  buildUserPrompt,
}: {
  systemPrompt: string;
  text: string;
  setText: (next: string) => void;
  getImages?: () => Blob[] | undefined | Promise<Blob[] | undefined>;
  /**
   * When provided alongside `setBaseText`, the snapshot used for undo is
   * controlled externally (e.g. persisted in a Zustand store). Otherwise the
   * hook keeps it in local state.
   */
  baseText?: string | null;
  setBaseText?: (next: string | null) => void;
  /**
   * Transform the text into the actual user message sent to the LLM (e.g. to
   * prepend a character/style context block). When omitted, `text` is sent
   * verbatim. The undo snapshot is always the original `text`.
   */
  buildUserPrompt?: (text: string) => string;
}) {
  const [localBaseText, setLocalBaseText] = useState<string | null>(null);
  const isControlled = controlledBaseText !== undefined && controlledSetBaseText !== undefined;
  const baseText = isControlled ? controlledBaseText : localBaseText;
  const setBaseText = isControlled ? controlledSetBaseText : setLocalBaseText;

  const [isImproving, setIsImproving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const improve = useCallback(async () => {
    if (!text.trim() || isImproving) return;
    const snapshot = text;
    setIsImproving(true);
    setError(null);
    try {
      const images = await getImages?.();
      const userPrompt = buildUserPrompt ? buildUserPrompt(text) : text;
      const improved = await callTextModel(systemPrompt, userPrompt, images);
      setText(improved.trim());
      setBaseText(snapshot);
      notifyImproveComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to improve text");
    } finally {
      setIsImproving(false);
    }
  }, [text, isImproving, getImages, setText, systemPrompt, setBaseText, buildUserPrompt]);

  const undo = useCallback(() => {
    if (baseText === null) return;
    setText(baseText);
    setBaseText(null);
  }, [baseText, setText, setBaseText]);

  const clearError = useCallback(() => setError(null), []);

  return {
    isImproving,
    hasUndo: baseText !== null,
    improve,
    undo,
    error,
    clearError,
  };
}
