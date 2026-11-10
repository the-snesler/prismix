import type { Route } from "./+types/home";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Loader2 } from "lucide-react";
import { Outlet } from "react-router";
import { Sidebar, MobileSidebar } from "~/components/sidebar/Sidebar";
import { MobileHeader } from "~/components/sidebar/MobileHeader";
import { NotificationPermissionPrompt } from "~/components/settings/NotificationPermissionPrompt";
import { Lightbox } from "~/components/lightbox/Lightbox";
import { useGalleryStore } from "~/stores/galleryStore";
import { useLightboxStore } from "~/stores/lightboxStore";
import { useSettingsStore } from "~/stores/settingsStore";
import { useGalleryDerivedIndexes } from "~/hooks/useGalleryDerivedIndexes";
import { useLightboxUrlSync } from "~/hooks/useLightboxUrlSync";
import { garbageCollectReferences } from "~/lib/db";
import { getGenerationBackend } from "~/lib/backend/generation";
import { isServerBackend } from "~/lib/backend/mode";
import {
  consumeSettingsSeedRequest,
  getSettingsLoadState,
  subscribeSettingsLoadState,
} from "~/lib/backend/settingsStorage";
import { logger } from "~/lib/logging";
import { DiffViewer } from "~/components/editor/DiffViewer";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Prismix - AI Image Generation" },
    { name: "description", content: "Generate images with AI models" },
  ];
}

/**
 * Server builds load settings asynchronously from the server. Hold the app until
 * they arrive so nothing (gallery load, reference GC, generation) runs against
 * default settings. Local builds hydrate synchronously from localStorage.
 */
function useSettingsHydrated(): boolean {
  const [hydrated, setHydrated] = useState(
    () => !isServerBackend || useSettingsStore.persist.hasHydrated()
  );
  useEffect(() => {
    if (hydrated) return;
    const unsubscribe = useSettingsStore.persist.onFinishHydration(() => setHydrated(true));
    if (useSettingsStore.persist.hasHydrated()) setHydrated(true);
    return unsubscribe;
  }, [hydrated]);
  useEffect(() => {
    // First run against an empty server: store the full current-version state.
    if (hydrated && isServerBackend && consumeSettingsSeedRequest()) {
      useSettingsStore.setState({});
    }
  }, [hydrated]);
  return hydrated;
}

function SettingsLoadingScreen() {
  const loadState = useSyncExternalStore(
    subscribeSettingsLoadState,
    getSettingsLoadState,
    getSettingsLoadState
  );

  return (
    <div className="text-text-muted flex h-screen flex-col items-center justify-center gap-3 text-sm">
      {loadState.status === "error" ? (
        <>
          <p className="text-red-400">Couldn&apos;t load settings from the server.</p>
          <p className="text-xs">{loadState.error}</p>
          <button
            type="button"
            className="rounded-md bg-zinc-800 px-3 py-1.5 text-zinc-100 hover:bg-zinc-700"
            onClick={() => void useSettingsStore.persist.rehydrate()}
          >
            Retry
          </button>
        </>
      ) : (
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading...
        </div>
      )}
    </div>
  );
}

export default function Home() {
  const settingsHydrated = useSettingsHydrated();
  return settingsHydrated ? <HomeLayout /> : <SettingsLoadingScreen />;
}

function HomeLayout() {
  // Server builds: restore in-flight and failed jobs and follow their progress.
  useEffect(() => getGenerationBackend().connect(), []);

  const loadImages = useGalleryStore((s) => s.loadImages);
  const hasLoaded = useGalleryStore((s) => s.hasLoaded);
  const isLightboxOpen = useLightboxStore((s) => s.isLightboxOpen);
  const desktopNotificationsEnabled = useSettingsStore((s) => s.desktopNotificationsEnabled);
  const { inFlightCount } = useGalleryDerivedIndexes();
  useLightboxUrlSync();
  const previousInFlightCountRef = useRef(0);

  useEffect(() => {
    if (!hasLoaded) {
      loadImages();
    }
  }, [hasLoaded, loadImages]);

  const hasGcRunRef = useRef(false);
  useEffect(() => {
    if (hasGcRunRef.current) return;
    hasGcRunRef.current = true;

    void (async () => {
      const settings = useSettingsStore.getState();
      const extraReachable: string[] = [
        ...settings.styles.map((s) => s.referenceImageId).filter((id): id is string => Boolean(id)),
        ...settings.characters.flatMap((c) => c.referenceImageIds),
      ];
      try {
        const deleted = await garbageCollectReferences(extraReachable);
        if (deleted > 0) logger.debug(`Garbage-collected ${deleted} orphaned reference image(s)`);
      } catch (err) {
        logger.error("Reference GC failed:", err);
      }
    })();
  }, []);

  useEffect(() => {
    const hadInFlight = previousInFlightCountRef.current > 0;

    previousInFlightCountRef.current = inFlightCount;

    if (!hadInFlight || inFlightCount !== 0) {
      return;
    }

    if (!desktopNotificationsEnabled) {
      return;
    }

    if (typeof window === "undefined" || !("Notification" in window)) {
      return;
    }

    if (Notification.permission !== "granted") {
      return;
    }

    if (!document.hidden && document.hasFocus()) {
      return;
    }

    new Notification("Prismix", {
      body: "All generations are complete.",
      tag: "prismix-generation-complete",
    });
  }, [inFlightCount, desktopNotificationsEnabled]);

  return (
    <div className="flex h-screen flex-col">
      <MobileHeader />
      <MobileSidebar />
      <Sidebar />
      <Outlet />
      {isLightboxOpen && <Lightbox />}
      <DiffViewer />
      <NotificationPermissionPrompt />
    </div>
  );
}
