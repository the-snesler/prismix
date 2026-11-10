import { Hono } from "hono";
import type { SettingsService } from "../settings";
import { HttpError, isObject, readJsonBody } from "./util";

export function settingsRoutes(settings: SettingsService) {
  const app = new Hono();

  app.get("/", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ value: settings.getSettingsValue() });
  });

  app.put("/", async (c) => {
    const body = await readJsonBody(c);
    if (!isObject(body) || typeof body.value !== "string") {
      throw new HttpError(400, "`value` must be a string");
    }
    try {
      JSON.parse(body.value);
    } catch {
      throw new HttpError(400, "`value` must be a JSON string");
    }
    settings.setSettingsValue(body.value);
    return c.json({ ok: true });
  });

  return app;
}
