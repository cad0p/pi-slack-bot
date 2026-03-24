/**
 * DM Poller — periodically checks the user's personal DMs via
 * workplace-chat-mcp (which has the user's own Slack auth).
 *
 * The Slack bot token can only see conversations the bot is in.
 * Personal DMs between the user and coworkers are invisible to the bot.
 * This poller bridges that gap by using the MCP tool to read DMs
 * on a regular interval, then feeding new messages through the
 * signal extraction + intent classification pipeline.
 *
 * Key constraint: NEVER sends messages. Read-only polling.
 */

import { execFile } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createLogger } from "./logger.js";
import { extractSignals, type MessageContext } from "./listener-signals.js";
import { processSignal } from "./listener-actions.js";
import { classifyIntent } from "./listener-intent.js";
import { processIntent } from "./listener-intent-actions.js";
import type { BriefingStore } from "./listener-store.js";

const log = createLogger("dm-poller");

/** Promise wrapper for execFile that works with mocks. */
function execFileAsync(
  cmd: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number; env: Record<string, string | undefined> },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: stdout as string, stderr: stderr as string });
    });
  });
}

const MCP_BIN = join(process.env.HOME ?? "", ".pi/agent/bin/mcp-call.js");
const MCP_SERVER = "workplace-chat-mcp";

/** Default poll interval: 2 minutes */
const DEFAULT_POLL_INTERVAL_MS = 2 * 60 * 1000;

/** Max DMs to check per poll cycle */
const MAX_DM_CHANNELS = 20;

/** Max messages per DM channel per poll */
const MAX_MESSAGES_PER_DM = 10;

interface DMPollState {
  /** Last poll timestamp (ISO string) */
  lastPoll: string;
  /** Per-channel last-seen message timestamp */
  lastSeen: Record<string, string>;
}

interface SlackMessage {
  user?: string;
  user_name?: string;
  text?: string;
  ts: string;
  type: string;
  subtype?: string;
}

interface MCPChannelResult {
  channelId: string;
  messages: SlackMessage[];
}

export interface DMPollerOptions {
  store: BriefingStore;
  /** Owner's Slack user ID (messages FROM this user are skipped) */
  ownerUserId: string;
  /** Poll interval in ms (default: 2 minutes) */
  intervalMs?: number;
  /** Directory to persist poll state */
  stateDir: string;
}

export interface DMPoller {
  start(): void;
  stop(): void;
  /** Run one poll cycle immediately (for testing) */
  pollOnce(): Promise<number>;
}

/** Run an MCP command and parse JSON output. */
async function mcpCall(tool: string, args: string, timeoutMs = 30_000): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync(
      "node",
      [MCP_BIN, "--server", MCP_SERVER, tool, args],
      {
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, PATH: process.env.PATH },
      },
    );
    return JSON.parse(stdout.trim());
  } catch (err) {
    log.debug("MCP call failed", { tool, error: err });
    return null;
  }
}

/** Resolve a user ID to a display name via MCP. */
const userNameCache = new Map<string, string>();

async function resolveUserName(userId: string): Promise<string | undefined> {
  if (userNameCache.has(userId)) return userNameCache.get(userId);

  try {
    const result = await mcpCall(
      "batch_get_user_info",
      JSON.stringify({ users: [userId] }),
    ) as { users?: Array<{ id: string; real_name?: string; display_name?: string }> } | null;

    const user = result?.users?.[0];
    const name = user?.real_name ?? user?.display_name;
    if (name) userNameCache.set(userId, name);
    return name;
  } catch {
    return undefined;
  }
}

function loadState(stateDir: string): DMPollState {
  const path = join(stateDir, "dm-poll-state.json");
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8"));
    }
  } catch (err) {
    log.warn("Failed to load poll state, starting fresh", { error: err });
  }
  return {
    lastPoll: new Date().toISOString(),
    lastSeen: {},
  };
}

function saveState(stateDir: string, state: DMPollState): void {
  const path = join(stateDir, "dm-poll-state.json");
  try {
    writeFileSync(path, JSON.stringify(state, null, 2));
  } catch (err) {
    log.error("Failed to save poll state", { error: err });
  }
}

/**
 * Get the user's recent DM channels by fetching channel sections.
 * The "Direct Messages" section contains DM channel IDs.
 * Falls back to checking a configured list of DM channels.
 */
async function getRecentDMChannels(stateDir: string): Promise<string[]> {
  // First try: read DM channels from config
  const configPath = join(process.env.HOME ?? "", ".pi-slack-bot", "listener.json");
  try {
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      if (Array.isArray(config.dmChannels) && config.dmChannels.length > 0) {
        return config.dmChannels;
      }
    }
  } catch { /* fall through */ }

  // Second try: get channel sections and find DMs
  try {
    const sections = await mcpCall("get_channel_sections", "{}") as {
      channel_sections?: Array<{
        type: string;
        channel_ids_page?: { channel_ids: string[] };
      }>;
    } | null;

    if (sections?.channel_sections) {
      const dmSection = sections.channel_sections.find((s) => s.type === "direct_messages");
      const dmChannels = dmSection?.channel_ids_page?.channel_ids ?? [];
      if (dmChannels.length > 0) {
        return dmChannels.slice(0, MAX_DM_CHANNELS);
      }
    }
  } catch (err) {
    log.debug("Failed to get DM channels from sections", { error: err });
  }

  // Third try: use cached state — poll whatever we polled last time
  const state = loadState(stateDir);
  return Object.keys(state.lastSeen).slice(0, MAX_DM_CHANNELS);
}

/**
 * Poll one DM channel for new messages since the last seen timestamp.
 */
async function pollChannel(
  channelId: string,
  oldest: string | undefined,
): Promise<SlackMessage[]> {
  const params: Record<string, unknown> = {
    channels: [{
      channelId,
      limit: MAX_MESSAGES_PER_DM,
      ...(oldest ? { oldest: new Date(parseFloat(oldest) * 1000).toISOString() } : {}),
    }],
  };

  const result = await mcpCall(
    "batch_get_conversation_history",
    JSON.stringify(params),
  ) as MCPChannelResult[] | null;

  if (!result || !Array.isArray(result) || result.length === 0) return [];

  const channelResult = result[0];
  return channelResult?.messages ?? [];
}

/**
 * Process a single DM message through the listener pipeline.
 */
async function processMessage(
  msg: SlackMessage,
  channelId: string,
  store: BriefingStore,
): Promise<boolean> {
  const text = msg.text ?? "";
  if (!text.trim()) return false;

  const userName = msg.user_name ?? (msg.user ? await resolveUserName(msg.user) : undefined);

  const ctx: MessageContext = {
    channel: channelId,
    channelName: userName ? `DM: ${userName}` : `DM: ${channelId}`,
    user: msg.user ?? "unknown",
    text,
    threadTs: msg.ts,
    ts: msg.ts,
  };

  // Try structured signals first
  const signals = extractSignals(text);
  let processed = false;

  if (signals.length > 0) {
    log.info("DM poller found signals", {
      from: userName ?? msg.user,
      signalCount: signals.length,
      types: signals.map((s) => s.type),
    });
    await Promise.allSettled(
      signals.map((signal) => processSignal(signal, ctx, store)),
    );
    processed = true;
  }

  // Intent classification for messages without structured signals
  if (signals.length === 0) {
    const intent = await classifyIntent(text, {
      channelName: `DM from ${userName ?? msg.user ?? "someone"}`,
      userName,
    });
    if (intent) {
      log.info("DM poller classified intent", {
        from: userName ?? msg.user,
        type: intent.type,
        topic: intent.topic,
      });
      await processIntent(intent, ctx, store);
      processed = true;
    }
  }

  return processed;
}

/**
 * Create a DM poller instance.
 */
export function createDMPoller(opts: DMPollerOptions): DMPoller {
  let timer: ReturnType<typeof setInterval> | null = null;
  let polling = false;
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  async function pollOnce(): Promise<number> {
    if (polling) {
      log.debug("Poll already in progress, skipping");
      return 0;
    }
    polling = true;

    try {
      const state = loadState(opts.stateDir);
      const dmChannels = await getRecentDMChannels(opts.stateDir);

      if (dmChannels.length === 0) {
        log.debug("No DM channels to poll");
        return 0;
      }

      log.debug("Polling DM channels", { count: dmChannels.length });
      let totalProcessed = 0;

      for (const channelId of dmChannels) {
        const oldest = state.lastSeen[channelId];
        const messages = await pollChannel(channelId, oldest);

        // Filter: only messages from OTHER people (not the owner)
        const newMessages = messages
          .filter((m) => m.user !== opts.ownerUserId)
          .filter((m) => !m.subtype || m.subtype === "file_share")
          .filter((m) => {
            // Only process messages newer than last seen
            if (!oldest) return true;
            return parseFloat(m.ts) > parseFloat(oldest);
          });

        if (newMessages.length > 0) {
          log.info("DM poller found new messages", {
            channel: channelId,
            count: newMessages.length,
          });

          for (const msg of newMessages) {
            const wasProcessed = await processMessage(msg, channelId, opts.store);
            if (wasProcessed) totalProcessed++;
          }
        }

        // Update last seen to the newest message in the channel (from anyone)
        if (messages.length > 0) {
          const newestTs = messages.reduce((max, m) =>
            parseFloat(m.ts) > parseFloat(max) ? m.ts : max, oldest ?? "0",
          );
          state.lastSeen[channelId] = newestTs;
        }
      }

      state.lastPoll = new Date().toISOString();
      saveState(opts.stateDir, state);

      if (totalProcessed > 0) {
        log.info("DM poll cycle complete", { processed: totalProcessed });
      }

      return totalProcessed;
    } catch (err) {
      log.error("DM poll cycle failed", { error: err });
      return 0;
    } finally {
      polling = false;
    }
  }

  return {
    start() {
      if (timer) return;
      log.info("DM poller started", { intervalMs });
      // Run first poll after a short delay (let the bot finish starting)
      setTimeout(() => pollOnce(), 5_000);
      timer = setInterval(() => pollOnce(), intervalMs);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        log.info("DM poller stopped");
      }
    },
    pollOnce,
  };
}
