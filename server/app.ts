import path from "node:path";
import { Hono } from "hono";
import type { ServerConfig } from "./config";
import { openDatabase, type Database } from "./db";
import { FileStore } from "./files";
import { SqliteGalleryRepository } from "./repository";
import { imageRoutes } from "./routes/images";
import { proxyRoutes } from "./routes/proxy";
import { referenceRoutes } from "./routes/references";
import { sessionRoutes } from "./routes/sessions";
import { settingsRoutes } from "./routes/settings";
import { staticRoutes } from "./routes/static";
import { HttpError } from "./routes/util";
import { SettingsService } from "./settings";
import { EventHub } from "./events";
import { JobRunner } from "./jobs";
import { eventRoutes, jobRoutes } from "./routes/jobs";
import { createThumbnail } from "./thumbnails";
import type { ApiKeys, Provider } from "~/types";

export interface AppDeps {
  config: ServerConfig;
  db: Database;
  files: FileStore;
  repository: SqliteGalleryRepository;
  settings: SettingsService;
  events: EventHub;
  jobs: JobRunner;
}

/** Open the database and file store under `config.dataDir`. */
export function createDeps(config: ServerConfig): AppDeps {
  const db = openDatabase(path.join(config.dataDir, "prismix.sqlite"));
  const files = new FileStore(config.dataDir);
  const repository = new SqliteGalleryRepository(db, files);
  const settings = new SettingsService(db);
  const events = new EventHub();
  const jobs = new JobRunner({
    db,
    repository,
    events,
    // Read on every call so a key changed in Settings applies to the next job.
    getApiKey: (provider: Provider) => {
      if (provider === "debug") return undefined;
      const apiKeys = settings.readSettingsState()?.apiKeys as Partial<ApiKeys> | undefined;
      return apiKeys?.[provider] ?? undefined;
    },
    createThumbnail: (blob) => createThumbnail(blob),
    concurrencyPerProvider: config.generationConcurrency,
  });
  return { config, db, files, repository, settings, events, jobs };
}

export function createApp(deps: AppDeps): Hono {
  const { config, repository, settings, events, jobs } = deps;
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: error.message }, error.status);
    console.error(`${c.req.method} ${c.req.path} failed:`, error);
    return c.json({ error: "Internal server error" }, 500);
  });

  // --- API -------------------------------------------------------------------
  const api = new Hono();
  api.get("/health", (c) => c.json({ ok: true }));
  api.route("/images", imageRoutes(repository));
  api.route("/references", referenceRoutes(repository));
  api.route("/sessions", sessionRoutes(repository));
  api.route("/settings", settingsRoutes(settings));
  api.route("/", jobRoutes(jobs));
  api.route("/events", eventRoutes(events));
  // M5: api.route("/export", exportRoutes(deps)); api.route("/import", importRoutes(deps));

  // Unmatched API paths are JSON 404s, never the SPA shell.
  api.all("*", (c) => c.json({ error: "Not found" }, 404));
  app.route("/api", api);

  // --- Provider pass-through for client-side text-model calls -------------------
  app.route("/proxy", proxyRoutes(config.upstream));

  // --- SPA -------------------------------------------------------------------
  app.route("/", staticRoutes(config.staticDir));
  app.all("*", (c) => c.text("Not found", 404));

  return app;
}
