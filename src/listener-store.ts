/**
 * Briefing store — file-based storage for prepared context.
 *
 * Stores background prep results (CR summaries, ticket details, etc.)
 * organized by channel and date. Retrievable via !briefing command.
 *
 * Smart dedup: tracks signal IDs from both direct messages AND content
 * discovered inside fetched resources (e.g., a CR mentioned inside a
 * SIM ticket description). This prevents redundant fetches when the
 * same artifact surfaces through multiple paths.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { createLogger } from "./logger.js";
import type { Signal, SignalType } from "./listener-signals.js";

const log = createLogger("listener-store");

/** A unique key for a signal — used for dedup lookups. */
export type SignalKey = string; // e.g. "cr:CR-12345678"

export function signalKey(type: SignalType | string, id: string): SignalKey {
  return `${type}:${id}`;
}

export interface BriefingEntry {
  /** When this was prepared */
  timestamp: string;
  /** Source channel */
  channel: string;
  channelName?: string;
  /** Who triggered this signal */
  user: string;
  /** The signal that triggered prep */
  signal: Signal;
  /** Human-readable summary of what was prepared */
  summary: string;
  /** Detailed prepared content */
  detail: string;
  /** Original message excerpt for context */
  messageExcerpt: string;
  /** Thread timestamp for reference */
  threadTs: string;
  /** Signal IDs discovered inside this entry's fetched content.
   *  These are "covered" by this entry and won't be fetched separately. */
  discoveredSignals?: SignalKey[];
  /** If this signal was already covered by another entry, link to it. */
  coveredBy?: SignalKey;
}

export class BriefingStore {
  private readonly baseDir: string;
  /**
   * In-memory set of all known signal keys for today — both stored entries
   * and signals discovered transitively inside fetched content.
   * Rebuilt from disk on first access each day.
   */
  private knownSignals = new Map<SignalKey, { source: "stored" | "discovered"; parentKey?: SignalKey }>();
  private knownSignalsDate = "";

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    if (!existsSync(baseDir)) {
      mkdirSync(baseDir, { recursive: true });
    }
  }

  /**
   * Check whether a signal is already known — either stored directly
   * or discovered inside another entry's content.
   */
  isKnown(type: SignalType | string, id: string): boolean {
    this.ensureKnownSignalsLoaded();
    return this.knownSignals.has(signalKey(type, id));
  }

  /**
   * Get info about why a signal is known (for logging/debugging).
   * Returns undefined if not known.
   */
  getKnownInfo(type: SignalType | string, id: string): { source: "stored" | "discovered"; parentKey?: SignalKey } | undefined {
    this.ensureKnownSignalsLoaded();
    return this.knownSignals.get(signalKey(type, id));
  }

  /** Add a briefing entry with optional discovered signals. */
  add(entry: BriefingEntry): void {
    this.ensureKnownSignalsLoaded();
    const date = new Date().toISOString().slice(0, 10);
    const filePath = this.filePath(date);
    const key = signalKey(entry.signal.type, entry.signal.id);

    let entries: BriefingEntry[] = [];
    if (existsSync(filePath)) {
      try {
        entries = JSON.parse(readFileSync(filePath, "utf-8"));
      } catch (err) {
        log.warn("Failed to read existing briefings, starting fresh", { path: filePath, error: err });
      }
    }

    // Deduplicate — don't store the same signal+id twice per day
    const isDuplicate = entries.some(
      (e) => e.signal.type === entry.signal.type && e.signal.id === entry.signal.id,
    );
    if (isDuplicate) {
      log.debug("Skipping duplicate briefing", { type: entry.signal.type, id: entry.signal.id });
      return;
    }

    entries.push(entry);
    writeFileSync(filePath, JSON.stringify(entries, null, 2));
    log.info("Stored briefing", { type: entry.signal.type, id: entry.signal.id });

    // Update in-memory index
    this.knownSignals.set(key, { source: "stored" });

    // Register discovered signals
    if (entry.discoveredSignals) {
      for (const dk of entry.discoveredSignals) {
        if (!this.knownSignals.has(dk)) {
          this.knownSignals.set(dk, { source: "discovered", parentKey: key });
          log.debug("Registered discovered signal", { discovered: dk, parent: key });
        }
      }
    }
  }

  /** Register discovered signals without a full briefing entry (e.g., from content scanning). */
  registerDiscovered(parentType: SignalType | string, parentId: string, discovered: SignalKey[]): void {
    this.ensureKnownSignalsLoaded();
    const parentKey = signalKey(parentType, parentId);
    for (const dk of discovered) {
      if (!this.knownSignals.has(dk)) {
        this.knownSignals.set(dk, { source: "discovered", parentKey });
        log.debug("Registered discovered signal", { discovered: dk, parent: parentKey });
      }
    }
  }

  /** Get today's briefings, optionally filtered by channel. */
  getToday(channel?: string): BriefingEntry[] {
    const date = new Date().toISOString().slice(0, 10);
    return this.getByDate(date, channel);
  }

  /** Get briefings for a specific date, optionally filtered by channel. */
  getByDate(date: string, channel?: string): BriefingEntry[] {
    const filePath = this.filePath(date);
    if (!existsSync(filePath)) return [];

    try {
      const entries: BriefingEntry[] = JSON.parse(readFileSync(filePath, "utf-8"));
      if (channel) return entries.filter((e) => e.channel === channel);
      return entries;
    } catch (err) {
      log.error("Failed to read briefings", { path: filePath, error: err });
      return [];
    }
  }

  /** Get recent briefings (last N days). */
  getRecent(days = 1, channel?: string): BriefingEntry[] {
    const entries: BriefingEntry[] = [];
    const now = new Date();

    for (let i = 0; i < days; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().slice(0, 10);
      entries.push(...this.getByDate(dateStr, channel));
    }

    return entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  /** Get unread count for today. */
  getTodayCount(): number {
    return this.getToday().length;
  }

  /** List available dates that have briefings. */
  listDates(): string[] {
    try {
      return readdirSync(this.baseDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(".json", ""))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  /**
   * Rebuild the in-memory known-signals index from today's entries on disk.
   * Called lazily on first access and when the date rolls over.
   */
  private ensureKnownSignalsLoaded(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (this.knownSignalsDate === today) return;

    this.knownSignals.clear();
    this.knownSignalsDate = today;

    const entries = this.getByDate(today);
    for (const entry of entries) {
      const key = signalKey(entry.signal.type, entry.signal.id);
      this.knownSignals.set(key, { source: "stored" });

      if (entry.discoveredSignals) {
        for (const dk of entry.discoveredSignals) {
          if (!this.knownSignals.has(dk)) {
            this.knownSignals.set(dk, { source: "discovered", parentKey: key });
          }
        }
      }
    }

    if (this.knownSignals.size > 0) {
      log.debug("Loaded known signals from disk", { count: this.knownSignals.size });
    }
  }

  private filePath(date: string): string {
    return join(this.baseDir, `${date}.json`);
  }
}
