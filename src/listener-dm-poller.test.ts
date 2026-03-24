import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { BriefingStore } from "./listener-store.js";

// Mock child_process for MCP calls
const mockExecFile = vi.fn();
vi.mock("child_process", () => ({
  execFile: mockExecFile,
}));

// Mock intent classification to avoid Bedrock calls
vi.mock("./listener-intent.js", () => ({
  classifyIntent: vi.fn().mockResolvedValue(null),
}));

// Mock processSignal and processIntent to avoid real external calls
// (they call execFile internally for cr-reader, tickety, etc.)
const mockProcessSignal = vi.fn().mockResolvedValue(undefined);
const mockProcessIntent = vi.fn().mockResolvedValue(undefined);
vi.mock("./listener-actions.js", () => ({
  processSignal: (...args: unknown[]) => mockProcessSignal(...args),
}));
vi.mock("./listener-intent-actions.js", () => ({
  processIntent: (...args: unknown[]) => mockProcessIntent(...args),
}));

const { createDMPoller } = await import("./listener-dm-poller.js");
const { classifyIntent } = await import("./listener-intent.js");

function makeMCPResponse(data: unknown): void {
  mockExecFile.mockImplementationOnce(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb(null, JSON.stringify(data), "");
    },
  );
}

function makeMCPError(): void {
  mockExecFile.mockImplementationOnce(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb(new Error("MCP unavailable"), "", "");
    },
  );
}

describe("DM Poller", () => {
  let tmpDir: string;
  let store: BriefingStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dm-poller-test-"));
    store = new BriefingStore(tmpDir);
    mockExecFile.mockReset();
    mockProcessSignal.mockReset().mockResolvedValue(undefined);
    mockProcessIntent.mockReset().mockResolvedValue(undefined);
    vi.mocked(classifyIntent).mockReset();
    vi.mocked(classifyIntent).mockResolvedValue(null);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a poller that can start and stop", () => {
    const poller = createDMPoller({
      store,
      ownerUserId: "U_OWNER",
      stateDir: tmpDir,
      intervalMs: 60_000,
    });
    poller.start();
    poller.stop();
  });

  it("returns 0 when no DM channels configured", async () => {
    // get_channel_sections returns empty
    makeMCPResponse({ channel_sections: [] });

    const poller = createDMPoller({
      store,
      ownerUserId: "U_OWNER",
      stateDir: tmpDir,
    });

    const count = await poller.pollOnce();
    expect(count).toBe(0);
  });

  it("polls DM channels from config and processes signals", async () => {
    const configPath = join(process.env.HOME ?? tmpDir, ".pi-slack-bot", "listener.json");
    const originalConfig = existsSync(configPath) ? readFileSync(configPath, "utf-8") : undefined;

    try {
      const config = originalConfig ? JSON.parse(originalConfig) : {};
      config.dmChannels = ["D_TEST_123"];
      writeFileSync(configPath, JSON.stringify(config));

      // MCP returns a message with a CR link
      makeMCPResponse([{
        channelId: "D_TEST_123",
        messages: [{
          user: "U_OTHER",
          user_name: "Alice",
          text: "Hey check out CR-99999999",
          ts: "9999999999.000000",
          type: "message",
        }],
      }]);

      const poller = createDMPoller({
        store,
        ownerUserId: "U_OWNER",
        stateDir: tmpDir,
      });

      const count = await poller.pollOnce();
      expect(count).toBe(1);
      expect(mockProcessSignal).toHaveBeenCalledOnce();

      // Check signal was extracted correctly
      const signalArg = mockProcessSignal.mock.calls[0][0];
      expect(signalArg.type).toBe("cr");
      expect(signalArg.id).toBe("CR-99999999");
    } finally {
      if (originalConfig) writeFileSync(configPath, originalConfig);
    }
  });

  it("skips messages from the owner", async () => {
    const configPath = join(process.env.HOME ?? tmpDir, ".pi-slack-bot", "listener.json");
    const originalConfig = existsSync(configPath) ? readFileSync(configPath, "utf-8") : undefined;

    try {
      const config = originalConfig ? JSON.parse(originalConfig) : {};
      config.dmChannels = ["D_TEST_456"];
      writeFileSync(configPath, JSON.stringify(config));

      makeMCPResponse([{
        channelId: "D_TEST_456",
        messages: [{
          user: "U_OWNER",
          text: "My own message with CR-88888888",
          ts: "9999999999.000000",
          type: "message",
        }],
      }]);

      const poller = createDMPoller({
        store,
        ownerUserId: "U_OWNER",
        stateDir: tmpDir,
      });

      const count = await poller.pollOnce();
      expect(count).toBe(0);
      expect(mockProcessSignal).not.toHaveBeenCalled();
    } finally {
      if (originalConfig) writeFileSync(configPath, originalConfig);
    }
  });

  it("persists poll state across cycles", async () => {
    const configPath = join(process.env.HOME ?? tmpDir, ".pi-slack-bot", "listener.json");
    const originalConfig = existsSync(configPath) ? readFileSync(configPath, "utf-8") : undefined;

    try {
      const config = originalConfig ? JSON.parse(originalConfig) : {};
      config.dmChannels = ["D_TEST_789"];
      writeFileSync(configPath, JSON.stringify(config));

      makeMCPResponse([{
        channelId: "D_TEST_789",
        messages: [{
          user: "U_OTHER",
          user_name: "Bob",
          text: "First message with CR-11111111",
          ts: "1000000000.000000",
          type: "message",
        }],
      }]);

      const poller = createDMPoller({
        store,
        ownerUserId: "U_OWNER",
        stateDir: tmpDir,
      });

      await poller.pollOnce();

      const statePath = join(tmpDir, "dm-poll-state.json");
      expect(existsSync(statePath)).toBe(true);
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      expect(state.lastSeen["D_TEST_789"]).toBe("1000000000.000000");
    } finally {
      if (originalConfig) writeFileSync(configPath, originalConfig);
    }
  });

  it("handles MCP failures gracefully", async () => {
    const configPath = join(process.env.HOME ?? tmpDir, ".pi-slack-bot", "listener.json");
    const originalConfig = existsSync(configPath) ? readFileSync(configPath, "utf-8") : undefined;

    try {
      const config = originalConfig ? JSON.parse(originalConfig) : {};
      config.dmChannels = ["D_TEST_FAIL"];
      writeFileSync(configPath, JSON.stringify(config));

      makeMCPError();

      const poller = createDMPoller({
        store,
        ownerUserId: "U_OWNER",
        stateDir: tmpDir,
      });

      const count = await poller.pollOnce();
      expect(count).toBe(0);
    } finally {
      if (originalConfig) writeFileSync(configPath, originalConfig);
    }
  });

  it("runs intent classification for messages without signals", async () => {
    const configPath = join(process.env.HOME ?? tmpDir, ".pi-slack-bot", "listener.json");
    const originalConfig = existsSync(configPath) ? readFileSync(configPath, "utf-8") : undefined;

    try {
      const config = originalConfig ? JSON.parse(originalConfig) : {};
      config.dmChannels = ["D_TEST_INTENT"];
      writeFileSync(configPath, JSON.stringify(config));

      makeMCPResponse([{
        channelId: "D_TEST_INTENT",
        messages: [{
          user: "U_OTHER",
          user_name: "Sophia",
          text: "Hey Sam, is our gamma stack calling HeartBeat prod?",
          ts: "9999999999.000000",
          type: "message",
        }],
      }]);

      vi.mocked(classifyIntent).mockResolvedValueOnce({
        type: "question",
        confidence: 0.9,
        topic: "Gamma stack HeartBeat connectivity",
        prepHints: ["search vault for HeartBeat", "search vault for gamma stack"],
        entities: ["gamma", "HeartBeat"],
      });

      const poller = createDMPoller({
        store,
        ownerUserId: "U_OWNER",
        stateDir: tmpDir,
      });

      const count = await poller.pollOnce();
      expect(count).toBe(1);
      expect(classifyIntent).toHaveBeenCalled();
      expect(mockProcessIntent).toHaveBeenCalledOnce();

      // Verify intent was passed correctly
      const intentArg = mockProcessIntent.mock.calls[0][0];
      expect(intentArg.type).toBe("question");
      expect(intentArg.topic).toBe("Gamma stack HeartBeat connectivity");
    } finally {
      if (originalConfig) writeFileSync(configPath, originalConfig);
    }
  });
});
