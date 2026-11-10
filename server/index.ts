import { serve } from "@hono/node-server";
import { setPlatform } from "~/lib/platform";
import { createApp, createDeps } from "./app";
import { loadConfig } from "./config";
import { createNodePlatform } from "./platform";

const config = loadConfig();
const deps = createDeps(config);

// Shared provider code (imported from app/lib) resolves its environment through
// the platform seam; install the Node implementation before anything runs.
setPlatform(createNodePlatform(deps.db, config));

// Requeue or fail the jobs a previous run left behind (needs the platform).
deps.jobs.recover();
// Resume imports that were running, and drop stale uploads.
void deps.uploads.recover().catch((error) => console.error("Upload recovery failed:", error));

const app = createApp(deps);

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`Prismix server listening on http://${info.address}:${info.port}`);
  console.log(`  data dir:   ${config.dataDir}`);
  console.log(`  static dir: ${config.staticDir}`);
});

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down`);
  const exit = () => {
    try {
      deps.db.close();
    } catch {
      // Already closed.
    }
    process.exit(0);
  };
  server.close(exit);
  // Don't hang on keep-alive connections.
  setTimeout(exit, 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
