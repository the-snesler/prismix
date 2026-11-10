import path from "node:path";

export interface ServerConfig {
  /** Root for the SQLite database and stored image/reference files. */
  dataDir: string;
  port: number;
  host: string;
  /** Built SPA (`build/client`). */
  staticDir: string;
  /** Concurrent generation requests per provider (`GENERATION_CONCURRENCY`). */
  generationConcurrency: number;
  /** Upstream origins for `/proxy/*` and server-side provider calls (no trailing slash). */
  upstream: {
    openai: string;
    replicate: string;
  };
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return port;
}

function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Invalid ${name}: ${value}`);
  return parsed;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/** The only place the server reads environment variables. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    dataDir: path.resolve(env.DATA_DIR || "/data"),
    port: parsePort(env.PORT, 8787),
    host: env.HOST || "0.0.0.0",
    staticDir: path.resolve(env.STATIC_DIR || "build/client"),
    generationConcurrency: parsePositiveInt(
      env.GENERATION_CONCURRENCY,
      4,
      "GENERATION_CONCURRENCY"
    ),
    upstream: {
      // Overridable mainly for testing against a local stub or routing through a gateway.
      openai: trimTrailingSlash(env.OPENAI_API_ORIGIN || "https://api.openai.com"),
      replicate: trimTrailingSlash(env.REPLICATE_API_ORIGIN || "https://api.replicate.com"),
    },
  };
}
