import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { BriefingStore, signalKey } from "./listener-store.js";
import type { Signal } from "./listener-signals.js";

function makeSignal(type: string, id: string): Signal {
  return { type: type as Signal["type"], raw: id, id, url: `https://example.com/${id}` };
}

describe("BriefingStore", () => {
  let tmpDir: string;
  let store: BriefingStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "briefing-test-"));
    store = new BriefingStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates base directory if missing", () => {
    const nested = join(tmpDir, "a", "b", "c");
    new BriefingStore(nested);
    expect(existsSync(nested)).toBe(true);
  });

  it("stores and retrieves a briefing entry", () => {
    store.add({
      timestamp: new Date().toISOString(),
      channel: "C123",
      user: "U456",
      signal: makeSignal("cr", "CR-11111111"),
      summary: "CR summary",
      detail: "Full details",
      messageExcerpt: "Check this CR",
      threadTs: "1234.5678",
    });

    const entries = store.getToday();
    expect(entries).toHaveLength(1);
    expect(entries[0].signal.id).toBe("CR-11111111");
    expect(entries[0].summary).toBe("CR summary");
  });

  it("deduplicates same signal type + id", () => {
    const entry = {
      timestamp: new Date().toISOString(),
      channel: "C123",
      user: "U456",
      signal: makeSignal("cr", "CR-11111111"),
      summary: "First",
      detail: "First detail",
      messageExcerpt: "msg",
      threadTs: "1234.5678",
    };

    store.add(entry);
    store.add({ ...entry, summary: "Second" });

    const entries = store.getToday();
    expect(entries).toHaveLength(1);
    expect(entries[0].summary).toBe("First");
  });

  it("allows different signal IDs", () => {
    store.add({
      timestamp: new Date().toISOString(),
      channel: "C123",
      user: "U456",
      signal: makeSignal("cr", "CR-11111111"),
      summary: "CR 1",
      detail: "d",
      messageExcerpt: "m",
      threadTs: "1",
    });
    store.add({
      timestamp: new Date().toISOString(),
      channel: "C123",
      user: "U456",
      signal: makeSignal("cr", "CR-22222222"),
      summary: "CR 2",
      detail: "d",
      messageExcerpt: "m",
      threadTs: "2",
    });

    expect(store.getToday()).toHaveLength(2);
  });

  it("filters by channel", () => {
    store.add({
      timestamp: new Date().toISOString(),
      channel: "C111",
      user: "U1",
      signal: makeSignal("cr", "CR-11111111"),
      summary: "s1",
      detail: "d",
      messageExcerpt: "m",
      threadTs: "1",
    });
    store.add({
      timestamp: new Date().toISOString(),
      channel: "C222",
      user: "U2",
      signal: makeSignal("sim", "V123"),
      summary: "s2",
      detail: "d",
      messageExcerpt: "m",
      threadTs: "2",
    });

    expect(store.getToday("C111")).toHaveLength(1);
    expect(store.getToday("C222")).toHaveLength(1);
    expect(store.getToday("C999")).toHaveLength(0);
  });

  it("returns today count", () => {
    expect(store.getTodayCount()).toBe(0);
    store.add({
      timestamp: new Date().toISOString(),
      channel: "C1",
      user: "U1",
      signal: makeSignal("cr", "CR-11111111"),
      summary: "s",
      detail: "d",
      messageExcerpt: "m",
      threadTs: "1",
    });
    expect(store.getTodayCount()).toBe(1);
  });

  it("returns empty for missing dates", () => {
    expect(store.getByDate("2020-01-01")).toEqual([]);
  });

  it("lists available dates", () => {
    store.add({
      timestamp: new Date().toISOString(),
      channel: "C1",
      user: "U1",
      signal: makeSignal("cr", "CR-11111111"),
      summary: "s",
      detail: "d",
      messageExcerpt: "m",
      threadTs: "1",
    });
    const dates = store.listDates();
    expect(dates).toHaveLength(1);
    expect(dates[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("signalKey", () => {
  it("produces a unique key from type and id", () => {
    expect(signalKey("cr", "CR-123")).toBe("cr:CR-123");
    expect(signalKey("sim", "V456")).toBe("sim:V456");
  });
});

describe("smart dedup", () => {
  let tmpDir: string;
  let store: BriefingStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "briefing-dedup-"));
    store = new BriefingStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("marks directly stored signals as known", () => {
    expect(store.isKnown("cr", "CR-11111111")).toBe(false);

    store.add({
      timestamp: new Date().toISOString(),
      channel: "C1",
      user: "U1",
      signal: makeSignal("cr", "CR-11111111"),
      summary: "s",
      detail: "d",
      messageExcerpt: "m",
      threadTs: "1",
    });

    expect(store.isKnown("cr", "CR-11111111")).toBe(true);
    const info = store.getKnownInfo("cr", "CR-11111111");
    expect(info?.source).toBe("stored");
  });

  it("marks discovered signals as known", () => {
    store.add({
      timestamp: new Date().toISOString(),
      channel: "C1",
      user: "U1",
      signal: makeSignal("sim", "V999"),
      summary: "SIM ticket with CR inside",
      detail: "This ticket references CR-55555555",
      messageExcerpt: "m",
      threadTs: "1",
      discoveredSignals: ["cr:CR-55555555", "pipeline:my-pipe"],
    });

    // The SIM itself is known (stored)
    expect(store.isKnown("sim", "V999")).toBe(true);
    expect(store.getKnownInfo("sim", "V999")?.source).toBe("stored");

    // The CR inside is known (discovered)
    expect(store.isKnown("cr", "CR-55555555")).toBe(true);
    const crInfo = store.getKnownInfo("cr", "CR-55555555");
    expect(crInfo?.source).toBe("discovered");
    expect(crInfo?.parentKey).toBe("sim:V999");

    // The pipeline is also discovered
    expect(store.isKnown("pipeline", "my-pipe")).toBe(true);
  });

  it("does not mark unrelated signals as known", () => {
    store.add({
      timestamp: new Date().toISOString(),
      channel: "C1",
      user: "U1",
      signal: makeSignal("cr", "CR-11111111"),
      summary: "s",
      detail: "d",
      messageExcerpt: "m",
      threadTs: "1",
    });

    expect(store.isKnown("cr", "CR-99999999")).toBe(false);
    expect(store.isKnown("sim", "V111")).toBe(false);
  });

  it("rebuilds known signals from disk on fresh store instance", () => {
    // First store instance writes entries
    store.add({
      timestamp: new Date().toISOString(),
      channel: "C1",
      user: "U1",
      signal: makeSignal("sim", "V100"),
      summary: "s",
      detail: "d",
      messageExcerpt: "m",
      threadTs: "1",
      discoveredSignals: ["cr:CR-88888888"],
    });

    // Second store instance should rebuild from disk
    const store2 = new BriefingStore(tmpDir);
    expect(store2.isKnown("sim", "V100")).toBe(true);
    expect(store2.isKnown("cr", "CR-88888888")).toBe(true);
    expect(store2.getKnownInfo("cr", "CR-88888888")?.source).toBe("discovered");
  });

  it("registerDiscovered adds to known signals without a briefing entry", () => {
    store.registerDiscovered("cr", "CR-11111111", ["sim:V777", "pipeline:deploy-1"]);

    expect(store.isKnown("sim", "V777")).toBe(true);
    expect(store.isKnown("pipeline", "deploy-1")).toBe(true);

    // But no briefing entries were created
    expect(store.getToday()).toHaveLength(0);
  });

  it("persists discoveredSignals in the entry on disk", () => {
    store.add({
      timestamp: new Date().toISOString(),
      channel: "C1",
      user: "U1",
      signal: makeSignal("cr", "CR-11111111"),
      summary: "s",
      detail: "d",
      messageExcerpt: "m",
      threadTs: "1",
      discoveredSignals: ["sim:V222"],
    });

    const entries = store.getToday();
    expect(entries[0].discoveredSignals).toEqual(["sim:V222"]);
  });
});
