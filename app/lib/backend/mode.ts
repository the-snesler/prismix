/**
 * Storage backend, fixed at build time. `VITE_BACKEND=server` builds the app for
 * the self-hosted Node server (`server/`): gallery data and settings live on the
 * server. Anything else (the default) keeps everything in the browser.
 */
export const isServerBackend: boolean = import.meta.env.VITE_BACKEND === "server";
