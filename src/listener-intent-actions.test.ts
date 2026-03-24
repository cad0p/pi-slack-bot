import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { processIntent } from "./listener-intent-actions.js";
import { BriefingStore } from "./listener-store.js";
import type { ClassifiedIntent } from "./listener-intent.js";
import type { MessageContext } from "./listener-signals.js";

// Mock child_process to avoid actual command execution
vi.mock("child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(new Error("mocked — no real commands"), "", "");
  }),
}));

function makeCtx(overrides: Partial<MessageContext> = {}): MessageContext {
  return {
    channel: "C123",
    channelName: "test-channel",
    user: "U456",
    text: "Can you check the pipeline?",
    threadTs: "1234.5678",
    ts: "1234.5678",
    ...overrides,
  };
}

describe("processIntent", () => {
  let tmpDir: string;
  let store: BriefingStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "intent-test-"));
    store = new BriefingStore(tmpDir);
  });

  it("stores a briefing entry for a question intent", async () => {
    const intent: ClassifiedIntent = {
      type: "question",
      confidence: 0.9,
      topic: "Pipeline status for Nessie",
      prepHints: ["check pipeline status for Nessie"],
      entities: ["Nessie"],
    };

    await processIntent(intent, makeCtx(), store);

    const entries = store.getToday();
    expect(entries).toHaveLength(1);
    expect(entries[0].summary).toContain("question");
    expect(entries[0].summary).toContain("Pipeline status for Nessie");
    expect(entries[0].detail).toContain("question");
    expect(entries[0].detail).toContain("confidence");
    expect(entries[0].signal.type).toBe("mention");
  });

  it("stores a briefing entry for an action request", async () => {
    const intent: ClassifiedIntent = {
      type: "action_request",
      confidence: 0.95,
      topic: "Review CSDefect CR",
      prepHints: ["check recent CRs for CSDefect"],
      entities: ["CSDefect"],
    };

    await processIntent(intent, makeCtx({ text: "Can you review the CSDefect CR?" }), store);

    const entries = store.getToday();
    expect(entries).toHaveLength(1);
    expect(entries[0].summary).toContain("action_request");
  });

  it("includes channel and user info", async () => {
    const intent: ClassifiedIntent = {
      type: "status_ask",
      confidence: 0.8,
      topic: "QoS progress",
      prepHints: [],
      entities: ["QoS"],
    };

    await processIntent(intent, makeCtx({ channelName: "defect-intel", user: "U789" }), store);

    const entries = store.getToday();
    expect(entries[0].channel).toBe("C123");
    expect(entries[0].channelName).toBe("defect-intel");
    expect(entries[0].user).toBe("U789");
  });

  it("handles empty prepHints gracefully", async () => {
    const intent: ClassifiedIntent = {
      type: "fyi",
      confidence: 0.7,
      topic: "New team process",
      prepHints: [],
      entities: [],
    };

    await processIntent(intent, makeCtx(), store);

    const entries = store.getToday();
    expect(entries).toHaveLength(1);
    expect(entries[0].detail).toContain("manually");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
