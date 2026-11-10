import type { Database } from "./db";

/** zustand `persist` key used by `~/stores/settingsStore`. */
export const SETTINGS_NAME = "studio-settings";

interface PersistedSettings {
  state: Record<string, unknown>;
  version: number;
}

function isPersistedSettings(value: unknown): value is PersistedSettings {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PersistedSettings).state === "object" &&
    (value as PersistedSettings).state !== null
  );
}

/**
 * The client's persisted settings, stored verbatim as the JSON string zustand's
 * `persist` writes (`{"state": {...}, "version": N}`). The server only looks
 * inside for features that need it (e.g. merging imported characters/styles).
 */
export class SettingsService {
  constructor(private readonly db: Database) {}

  getSettingsValue(): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE name = ?").get(SETTINGS_NAME) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setSettingsValue(value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (name, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(SETTINGS_NAME, value, Date.now());
  }

  private readPersisted(): PersistedSettings | null {
    const value = this.getSettingsValue();
    if (value === null) return null;
    try {
      const parsed: unknown = JSON.parse(value);
      return isPersistedSettings(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** The parsed `.state`, or null if nothing (valid) is stored yet. */
  readSettingsState(): Record<string, unknown> | null {
    return this.readPersisted()?.state ?? null;
  }

  /**
   * Mutate the stored state in place (or return a replacement) and save it,
   * keeping the stored `version` so the client doesn't re-run migrations.
   *
   * Returns false without writing when no settings are stored: the client seeds
   * the server with its full, current-version state on first load, and writing
   * a partial state under a guessed version could trip its migrations.
   */
  updateSettingsState(
    mutate: (state: Record<string, unknown>) => Record<string, unknown> | void
  ): boolean {
    const persisted = this.readPersisted();
    if (!persisted) return false;
    const next = mutate(persisted.state) ?? persisted.state;
    this.setSettingsValue(JSON.stringify({ ...persisted, state: next }));
    return true;
  }
}
