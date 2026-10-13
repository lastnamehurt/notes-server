import { parseAwarenessEvent, type AwarenessEvent } from "./awareness-contracts";

/** Awareness history is deliberately independent of either notes backend. */
export interface AwarenessStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(keys: string | string[]): Promise<unknown>;
  list<T = unknown>(options: { prefix: string; limit?: number }): Promise<Map<string, T>>;
}

const PREFIX = "awareness:event:";
export const AWARENESS_RETENTION_MS = 30 * 86_400_000;
const BATCH_SIZE = 128;
const eventKey = (ownerId: string, eventId: string) =>
  PREFIX + encodeURIComponent(ownerId) + ":" + encodeURIComponent(eventId);
const ownerPrefix = (ownerId: string) => PREFIX + encodeURIComponent(ownerId) + ":";

export interface AwarenessAppendResult { inserted: boolean; event: AwarenessEvent }

/**
 * Call from the owner-scoped ReminderScheduler Durable Object. Its serial
 * execution provides the single-writer boundary; callers must not use this
 * class directly from parallel Workers with a non-serializing store.
 */
export class AwarenessEventStore {
  constructor(private readonly storage: AwarenessStorage) {}

  async append(input: unknown, ownerId: string): Promise<AwarenessAppendResult> {
    const event = parseAwarenessEvent(input, ownerId);
    const key = eventKey(ownerId, event.id);
    const existing = await this.storage.get<AwarenessEvent>(key);
    if (existing) {
      // Never silently replace the payload of an already accepted event.
      if (JSON.stringify(existing) !== JSON.stringify(event)) {
        throw new Error("Awareness event ID conflict");
      }
      return { inserted: false, event: existing };
    }
    await this.storage.put(key, event);
    return { inserted: true, event };
  }

  /** Ordered by event time, then ID, regardless of arrival order. */
  async list(ownerId: string, limit = 100): Promise<AwarenessEvent[]> {
    if (!ownerId || limit < 1 || limit > 500 || !Number.isInteger(limit)) throw new Error("Invalid awareness query");
    const events = await this.storage.list<AwarenessEvent>({ prefix: ownerPrefix(ownerId) });
    return [...events.values()].sort((a, b) =>
      a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id)).slice(-limit);
  }

  /** Delete only this owner's expired events. Bounded to avoid long DO calls. */
  async prune(ownerId: string, now = Date.now()): Promise<number> {
    if (!ownerId || !Number.isFinite(now)) throw new Error("Invalid awareness prune request");
    const events = await this.storage.list<AwarenessEvent>({ prefix: ownerPrefix(ownerId) });
    const expired = [...events].filter(([, event]) =>
      Date.parse(event.observedAt) < now - AWARENESS_RETENTION_MS).slice(0, BATCH_SIZE);
    if (expired.length) await this.storage.delete(expired.map(([key]) => key));
    return expired.length;
  }
}
