import { Select } from "@base-ui/react/select";
import { Check, ChevronDown, Plus, User } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { getReferenceImagesByIds } from "~/lib/db";
import { useGenerationStore } from "~/stores/generationStore";
import { useSettingsStore } from "~/stores/settingsStore";
import { usePortalContainer } from "~/components/ui/PortalContainer";

function CharacterThumbnail({ referenceImageId }: { referenceImageId: string }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let createdUrl: string | null = null;
    getReferenceImagesByIds([referenceImageId]).then(([img]) => {
      if (!active) return;
      if (img) {
        createdUrl = img.url;
        setUrl(img.url);
      }
    });
    return () => {
      active = false;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [referenceImageId]);

  if (!url) {
    return <div className="bg-surface-interactive h-4 w-4 shrink-0 rounded opacity-50" />;
  }

  return (
    <img
      src={url}
      alt=""
      className="border-c-border/50 h-4 w-4 shrink-0 rounded border object-cover"
    />
  );
}

export function CharacterSelect() {
  const navigate = useNavigate();
  const characters = useSettingsStore((s) => s.characters);
  const characterIds = useGenerationStore((s) => s.currentCharacterIds);
  const setCharacterIds = useGenerationStore((s) => s.setCharacterIds);
  const portalContainer = usePortalContainer();

  const enabledCharacters = characters.filter((c) => c.enabled);
  const selected = characterIds
    .map((id) => enabledCharacters.find((c) => c.id === id))
    .filter((c): c is NonNullable<typeof c> => c !== undefined);
  const first = selected[0] ?? null;
  const extraCount = selected.length - 1;

  return (
    <Select.Root<string, true>
      multiple
      value={characterIds}
      onValueChange={(value) => setCharacterIds(value)}
    >
      <Select.Trigger className="text-text-tertiary hover:text-text-secondary inline-flex max-w-full items-center gap-1 truncate text-xs transition-colors">
        {first?.referenceImageIds?.[0] ? (
          <CharacterThumbnail referenceImageId={first.referenceImageIds[0]} />
        ) : (
          <User className="h-3.5 w-3.5 shrink-0" />
        )}
        <Select.Value className="truncate">
          {first ? (extraCount > 0 ? `${first.name} +${extraCount}` : first.name) : "Character"}
        </Select.Value>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </Select.Trigger>
      <Select.Portal container={portalContainer}>
        <Select.Positioner sideOffset={6} className="z-50">
          <Select.Popup className="bg-surface-overlay border-c-border animate-in fade-in zoom-in-95 flex max-h-72 min-w-48 flex-col overflow-y-auto rounded-lg border p-1 text-sm shadow-lg">
            {enabledCharacters.map((character) => (
              <Select.Item
                key={character.id}
                value={character.id}
                className="text-text-secondary data-highlighted:bg-surface-raised flex items-center gap-2 rounded px-2 py-1.5 outline-none"
              >
                <span className="flex h-3 w-3 items-center justify-center">
                  <Select.ItemIndicator>
                    <Check className="h-3 w-3" />
                  </Select.ItemIndicator>
                </span>
                {character.referenceImageIds[0] ? (
                  <CharacterThumbnail referenceImageId={character.referenceImageIds[0]} />
                ) : (
                  <User className="h-4 w-4 shrink-0 opacity-50" />
                )}
                <div className="flex flex-col">
                  <Select.ItemText>{character.name}</Select.ItemText>
                </div>
              </Select.Item>
            ))}
            <div className="border-border-subtle mt-1 border-t pt-1">
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  navigate("/app/settings#characters");
                }}
                className="text-text-tertiary hover:bg-surface-raised flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors outline-none"
              >
                <span className="flex h-3 w-3 items-center justify-center" />
                <Plus className="h-4 w-4 shrink-0" />
                <span>Add character</span>
              </button>
            </div>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
