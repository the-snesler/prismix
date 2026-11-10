/**
 * In-process fan-out for `/api/events` (server-sent events). Clients resync with
 * `GET /api/jobs/items` whenever their stream (re)opens, so there's no replay buffer.
 */
export type ServerEvent =
  | { type: "item"; data: unknown }
  | { type: "item-removed"; data: { id: string } };

type Listener = (event: ServerEvent) => void;

export class EventHub {
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: ServerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken stream must not stop delivery to the others.
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}
