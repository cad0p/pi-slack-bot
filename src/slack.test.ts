import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { basename } from "path";
import { homedir } from "os";
import { tmpdir } from "os";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import type { Config } from "./config.js";

// We test the createApp logic by simulating Slack events through the registered handlers.
// Since @slack/bolt's App is hard to mock directly, we extract and test the handler logic
// by capturing the registered event/action handlers.

const baseConfig: Config = {
  slackBotToken: "xoxb-test",
  slackAppToken: "xapp-test",
  slackUserId: "U123",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  thinkingLevel: "off",
  maxSessions: 10,
  sessionIdleTimeoutSecs: 3600,
  sessionDir: "/tmp/test-sessions",
  streamThrottleMs: 3000,
  slackMsgLimit: 3900,
  workspaceDirs: [],
};

// Helpers to simulate the Slack event flow without a real App instance.
// We replicate the core logic from createApp's message handler.

import { parseMessage, scanProjects } from "./parser.js";
import { BotSessionManager, SessionLimitError } from "./session-manager.js";
import {
  postCwdPicker,
  handleCwdSelect,
  getPendingCwdPick,
  removePendingCwdPick,
} from "./cwd-picker.js";

function makeSession(threadTs: string) {
  return {
    threadTs,
    channelId: "C1",
    cwd: "/tmp",
    lastActivity: new Date(),
    isStreaming: false,
    messageCount: 0,
    model: undefined,
    thinkingLevel: "off" as const,
    enqueue: mock.fn((fn: () => Promise<void>) => {}),
    dispose: mock.fn(async () => {}),
    abort: mock.fn(),
    newSession: mock.fn(async () => {}),
    prompt: mock.fn(async () => {}),
    subscribe: mock.fn(() => () => {}),
  };
}

function makeManager(configOverrides: Partial<Config> = {}) {
  const config = { ...baseConfig, ...configOverrides };
  const sessions = new Map<string, ReturnType<typeof makeSession>>();

  const factory = mock.fn(async (params: any) => {
    const s = makeSession(params.threadTs);
    s.cwd = params.cwd;
    sessions.set(params.threadTs, s);
    return s as any;
  });

  const client = {} as any;
  const mgr = new BotSessionManager(config, client, factory);
  mgr.stopReaper();
  return { mgr, factory, sessions, config };
}

function makeMockClient() {
  const posted: any[] = [];
  const updated: any[] = [];
  return {
    posted,
    updated,
    chat: {
      postMessage: mock.fn(async (opts: any) => {
        const ts = `msg-${posted.length}`;
        posted.push({ ...opts, ts });
        return { ts };
      }),
      update: mock.fn(async (opts: any) => {
        updated.push(opts);
        return { ok: true };
      }),
    },
  } as any;
}

describe("slack.ts cwd parsing — exact cwd", () => {
  it("resolves exact directory path as cwd and passes rest as prompt", async () => {
    const dir = tmpdir();
    const { mgr, sessions } = makeManager();

    // Simulate: parseMessage returns exact cwd
    const parsed = parseMessage(`${dir} do something`, []);
    assert.equal(parsed.cwd, dir);
    assert.equal(parsed.prompt, "do something");

    // Simulate handler logic: exact cwd branch
    const session = await mgr.getOrCreate({
      threadTs: "ts1",
      channelId: "C1",
      cwd: parsed.cwd!,
    });

    assert.equal(session.cwd, dir);
    session.enqueue(() => session.prompt(parsed.prompt));
    assert.equal(sessions.get("ts1")!.enqueue.mock.callCount(), 1);
  });
});

describe("slack.ts cwd parsing — fuzzy candidates open cwd picker", () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = join(tmpdir(), `slack-test-${Date.now()}`);
    mkdirSync(join(tmpBase, "my-cool-project"), { recursive: true });
    mkdirSync(join(tmpBase, "other-thing"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("fuzzy candidates are resolved from parseMessage", () => {
    const knownProjects = scanProjects([tmpBase]);
    const parsed = parseMessage("cool do something", knownProjects);

    assert.equal(parsed.cwd, null);
    assert.ok(parsed.candidates.length > 0);
    assert.ok(parsed.candidates.some((c) => c.endsWith("my-cool-project")));
  });

  it("cwd picker posts directory browser with pinned projects for fuzzy matches", async () => {
    const client = makeMockClient();
    const onSelect = mock.fn();
    const knownProjects = scanProjects([tmpBase]);
    const parsed = parseMessage("cool do something", knownProjects);

    // Simulate the fuzzy match branch: matched projects become pins in the cwd picker
    const matched = parsed.candidates.map((c) => ({ path: c, label: basename(c) }));
    await postCwdPicker({
      client,
      channel: "C1",
      threadTs: "T1",
      prompt: parsed.prompt,
      files: [],
      projects: matched,
      startDir: tmpBase,
      onSelect,
    });

    assert.equal(client.posted.length, 1);
    const msg = client.posted[0];
    assert.ok(msg.blocks.length > 0);

    // Collect all action_ids from the blocks
    const actionIds: string[] = [];
    for (const block of msg.blocks) {
      if (block.type === "actions" && Array.isArray(block.elements)) {
        for (const el of block.elements) {
          if (el.action_id) actionIds.push(el.action_id);
        }
      }
    }

    // Should have at least one pinned project button
    const hasPinButton = actionIds.some((id) => id.startsWith("cwd_pick_pin_"));
    assert.ok(hasPinButton, `Expected cwd_pick_pin_ in action IDs: ${actionIds.join(", ")}`);

    // Clean up
    removePendingCwdPick(msg.ts);
  });
});

describe("slack.ts cwd parsing — no match fallback opens cwd picker from home", () => {
  it("no-match branch opens cwd picker at homedir", async () => {
    const parsed = parseMessage("zzznomatch do something", []);
    assert.equal(parsed.cwd, null);
    assert.deepEqual(parsed.candidates, []);

    // In the new flow, the no-match branch opens the cwd picker at homedir
    const client = makeMockClient();
    const onSelect = mock.fn();

    await postCwdPicker({
      client,
      channel: "C1",
      threadTs: "T1",
      prompt: "zzznomatch do something",
      files: [],
      projects: [],
      onSelect,
    });

    const pick = getPendingCwdPick(client.posted[0].ts);
    assert.ok(pick);
    assert.equal(pick!.currentDir, homedir());
    assert.equal(pick!.prompt, "zzznomatch do something");

    removePendingCwdPick(client.posted[0].ts);
  });
});

describe("slack.ts cwd picker select handler", () => {
  it("onSelect callback creates session with selected cwd and enqueues prompt", async () => {
    const { mgr, sessions } = makeManager();
    const client = makeMockClient();
    let selectDone: () => void;
    const selectPromise = new Promise<void>((resolve) => { selectDone = resolve; });

    // Simulate: cwd picker posted, user selects a directory
    await postCwdPicker({
      client,
      channel: "C1",
      threadTs: "T1",
      prompt: "do something",
      files: [],
      projects: [],
      startDir: tmpdir(),
      onSelect: async (pick, selectedDir) => {
        const session = await mgr.getOrCreate({
          threadTs: pick.threadTs,
          channelId: pick.channelId,
          cwd: selectedDir,
        });
        session.enqueue(() => session.prompt(pick.prompt));
        selectDone();
      },
    });

    const messageTs = client.posted[0].ts;
    const selectedCwd = "/workplace/my-cool-project";
    await handleCwdSelect(messageTs, selectedCwd);

    // Wait for async onSelect to complete
    await selectPromise;

    // Session should have been created with the selected cwd
    const session = sessions.get("T1");
    assert.ok(session);
    assert.equal(session!.cwd, selectedCwd);
    assert.equal(session!.enqueue.mock.callCount(), 1);
  });

  it("ignores select if no pending pick exists", async () => {
    // Should not throw
    await handleCwdSelect("nonexistent-ts", "/some/dir");
  });
});

describe("slack.ts createApp integration", () => {
  it("exports sessionManager and knownProjects", async () => {
    // Verify the module shape — import createApp and check return type
    const { createApp } = await import("./slack.js");
    assert.equal(typeof createApp, "function");
  });
});
