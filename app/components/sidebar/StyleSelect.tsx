import { Select } from "@base-ui/react/select";
import { Check, ChevronDown, Palette } from "lucide-react";
import { useGenerationStore } from "~/stores/generationStore";
import { useSettingsStore } from "~/stores/settingsStore";
import { usePortalContainer } from "~/components/ui/PortalContainer";

export function StyleSelect() {
  const styles = useSettingsStore((s) => s.styles);
  const styleId = useGenerationStore((s) => s.currentStyleId);
  const setStyleId = useGenerationStore((s) => s.setStyleId);
  const portalContainer = usePortalContainer();

  const enabledStyles = styles.filter((s) => s.enabled);
  const selected = styleId ? enabledStyles.find((s) => s.id === styleId) : null;

  return (
    <Select.Root<string | null>
      value={styleId}
      onValueChange={(value) => setStyleId(value ?? null)}
    >
      <Select.Trigger className="text-text-tertiary hover:text-text-secondary inline-flex max-w-full items-center gap-1 truncate text-xs transition-colors">
        <Palette className="h-3.5 w-3.5 shrink-0" />
        <Select.Value className="truncate">{selected?.name ?? "Style"}</Select.Value>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </Select.Trigger>
      <Select.Portal container={portalContainer}>
        <Select.Positioner sideOffset={6} className="z-50">
          <Select.Popup className="bg-surface-overlay border-c-border animate-in fade-in zoom-in-95 max-h-72 min-w-48 overflow-y-auto rounded-lg border p-1 text-sm shadow-lg">
            <Select.Item
              value={null}
              className="text-text-secondary data-highlighted:bg-surface-raised flex items-center gap-2 rounded px-2 py-1.5 outline-none"
            >
              <span className="flex h-3 w-3 items-center justify-center">
                <Select.ItemIndicator>
                  <Check className="h-3 w-3" />
                </Select.ItemIndicator>
              </span>
              <Select.ItemText>None</Select.ItemText>
            </Select.Item>
            {enabledStyles.map((style) => (
              <Select.Item
                key={style.id}
                value={style.id}
                className="text-text-secondary data-highlighted:bg-surface-raised flex items-center gap-2 rounded px-2 py-1.5 outline-none"
              >
                <span className="flex h-3 w-3 items-center justify-center">
                  <Select.ItemIndicator>
                    <Check className="h-3 w-3" />
                  </Select.ItemIndicator>
                </span>
                <Select.ItemText>{style.name}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
