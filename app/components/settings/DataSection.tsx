import { Archive, Download, Loader2, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getImageCount } from "~/lib/db";
import { exportAllImages, importFromZip, type ImportProgress } from "~/lib/exportImport";
import { isServerBackend } from "~/lib/backend/mode";
import { useGalleryStore } from "~/stores/galleryStore";
import { useSettingsStore } from "~/stores/settingsStore";
import { SettingsSectionHeader } from "./SettingsSectionHeader";

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

function ImportProgressBar({ progress }: { progress: ImportProgress }) {
  const fraction = progress.total > 0 ? Math.min(1, progress.loaded / progress.total) : 0;
  const label =
    progress.phase === "uploading"
      ? `Uploading ${formatBytes(progress.loaded)} of ${formatBytes(progress.total)}`
      : progress.total > 0
        ? `Importing ${progress.loaded.toLocaleString()} of ${progress.total.toLocaleString()} items`
        : "Reading archive...";
  return (
    <div className="max-w-md space-y-1">
      <div
        className="bg-surface-overlay h-1.5 overflow-hidden rounded-full"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
      >
        <div
          className="h-full rounded-full bg-purple-500 transition-[width] duration-300"
          style={{ width: `${fraction * 100}%` }}
        />
      </div>
      <p className="text-text-tertiary flex justify-between gap-2 text-xs tabular-nums">
        <span>{label}</span>
        <span>{Math.floor(fraction * 100)}%</span>
      </p>
    </div>
  );
}

export function DataSection() {
  const loadImages = useGalleryStore((s) => s.loadImages);
  const characterCount = useSettingsStore((s) => s.characters.length);
  const styleCount = useSettingsStore((s) => s.styles.filter((style) => style.isCustom).length);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [imageCount, setImageCount] = useState<number>(-1);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const importAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    getImageCount().then(setImageCount);
  }, []);

  const handleExport = async () => {
    setExporting(true);
    setStatus(null);
    try {
      await exportAllImages();
      setStatus("Export complete.");
    } catch (error) {
      setStatus(`Export failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setExporting(false);
    }
  };

  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setImporting(true);
    setStatus(null);
    setProgress(null);
    const controller = new AbortController();
    importAbortRef.current = controller;
    try {
      const result = await importFromZip(file, {
        onProgress: setProgress,
        signal: controller.signal,
      });
      const parts = [`${result.imported} generations imported`];
      if (result.referencesImported > 0) {
        parts.push(`${result.referencesImported} references imported`);
      }
      if (result.charactersImported > 0) {
        parts.push(
          `${result.charactersImported} character${result.charactersImported !== 1 ? "s" : ""} imported`
        );
      }
      if (result.stylesImported > 0) {
        parts.push(
          `${result.stylesImported} custom style${result.stylesImported !== 1 ? "s" : ""} imported`
        );
      }
      if (result.skipped > 0) parts.push(`${result.skipped} skipped (already exist)`);
      if (result.failed > 0) parts.push(`${result.failed} failed`);
      setStatus(parts.join(", "));

      if (result.imported > 0) {
        await loadImages();
        setImageCount(await getImageCount());
      }
    } catch (error) {
      if (controller.signal.aborted) {
        setStatus("Import canceled. Anything already imported was kept.");
        await loadImages();
        setImageCount(await getImageCount());
      } else {
        setStatus(`Import failed: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    } finally {
      importAbortRef.current = null;
      setProgress(null);
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <section id="data" className="group space-y-3">
      <SettingsSectionHeader
        icon={Archive}
        title="Data"
        subtitle={`Export or import all ${imageCount} gallery image${imageCount !== 1 ? "s" : ""}, ${characterCount} character${characterCount !== 1 ? "s" : ""}, and ${styleCount} custom style${styleCount !== 1 ? "s" : ""} as a ZIP file.`}
      />

      <div className="ml-6 space-y-3">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting || importing || imageCount === 0}
            className="bg-surface-overlay text-text-secondary hover:bg-surface-interactive flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60"
          >
            {exporting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            {exporting ? "Exporting..." : "Export all images"}
          </button>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={exporting || importing}
            className="bg-surface-overlay text-text-secondary hover:bg-surface-interactive flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60"
          >
            {importing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            {importing ? "Importing..." : "Import from ZIP"}
          </button>

          {importing && isServerBackend && (
            <button
              type="button"
              onClick={() => importAbortRef.current?.abort()}
              className="text-text-secondary hover:bg-surface-interactive flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
            >
              <X className="h-3.5 w-3.5" />
              Cancel
            </button>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept=".zip"
            onChange={handleImport}
            className="hidden"
          />
        </div>

        {importing && progress && <ImportProgressBar progress={progress} />}
        {status && <p className="text-text-tertiary text-xs">{status}</p>}
      </div>
    </section>
  );
}
