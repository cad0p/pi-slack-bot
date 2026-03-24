/**
 * Passive listener — monitors configured Slack channels and DMs
 * without responding. Extracts signals from messages and triggers
 * background preparation actions.
 *
 * Key constraint: NEVER posts messages to monitored channels.
 * All prepared context is stored in the briefing store for retrieval
 * via the !briefing command.
 */

import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import type { Config } from "./config.js";
import { extractSignals, type MessageContext } from "./listener-signals.js";
import { processSignal } from "./listener-actions.js";
import { classifyIntent } from "./listener-intent.js";
import { processIntent } from "./listener-intent-actions.js";
import { BriefingStore } from "./listener-store.js";
import { createLogger } from "./logger.js";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const log = createLogger("listener");

export interface ListenerConfig {
  /** Channel IDs to monitor (in addition to DMs) */
  channels: string[];
  /** Whether the listener is enabled */
  enabled: boolean;
  /** Static channel name mappings from config (avoids API calls) */
  channelNames: Record<string, string>;
}

/**
 * Load listener configuration from the config file.
 * Config file: ~/.pi-slack-bot/listener.json
 *
 * Format:
 * {
 *   "enabled": true,
 *   "channels": ["C01234ABCDE", "C05678FGHIJ"],
 *   "channelNames": { "C01234ABCDE": "team-defect-intel" }
 * }
 */
export function loadListenerConfig(): ListenerConfig {
  const configPath = join(
    process.env.HOME ?? "",
    ".pi-slack-bot",
    "listener.json",
  );

  try {
    if (!existsSync(configPath)) {
      log.info("No listener config found, listener disabled", { path: configPath });
      return { channels: [], enabled: false, channelNames: {} };
    }

    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    return {
      enabled: raw.enabled ?? false,
      channels: raw.channels ?? [],
      channelNames: raw.channelNames ?? {},
    };
  } catch (err) {
    log.error("Failed to load listener config", { error: err });
    return { channels: [], enabled: false, channelNames: {} };
  }
}

/** Channel name cache — populated lazily */
const channelNameCache = new Map<string, string>();

async function resolveChannelName(client: WebClient, channelId: string): Promise<string | undefined> {
  if (channelNameCache.has(channelId)) return channelNameCache.get(channelId);

  try {
    const info = await client.conversations.info({ channel: channelId });
    const name = info.channel?.name ?? info.channel?.id;
    if (name) channelNameCache.set(channelId, name);
    return name;
  } catch {
    return undefined;
  }
}

export interface Listener {
  store: BriefingStore;
  listenerConfig: ListenerConfig;
}

/**
 * Install the passive listener on a Slack app.
 *
 * This registers a secondary message handler that watches configured channels
 * and DMs (excluding the bot's own conversation threads) for actionable signals.
 */
export async function installListener(
  app: App,
  config: Config,
): Promise<Listener> {
  const listenerConfig = loadListenerConfig();
  const store = new BriefingStore(
    join(config.sessionDir, "..", "briefings"),
  );

  if (!listenerConfig.enabled) {
    log.info("Listener is disabled");
    return { store, listenerConfig };
  }

  log.info("Installing passive listener", {
    channelCount: listenerConfig.channels.length,
    channels: listenerConfig.channels,
  });

  // Seed the channel name cache from config to avoid API lookups
  for (const [id, name] of Object.entries(listenerConfig.channelNames)) {
    channelNameCache.set(id, name);
  }

  const monitoredChannels = new Set(listenerConfig.channels);

  // Register a message event handler that runs alongside the main one.
  // The main handler in slack.ts only processes messages from the bot owner
  // in direct bot threads. This handler watches additional channels passively.
  app.event("message", async ({ event, client }) => {
    // Only handle regular messages and file shares
    if (!("text" in event)) return;
    const subtype = "subtype" in event ? event.subtype : undefined;
    if (subtype && subtype !== "file_share") return;

    const channel = event.channel;
    const user = "user" in event ? event.user : undefined;

    // Skip bot's own messages
    if (!user) return;

    // Check if this is a DM to the bot owner or a monitored channel
    const isDM = channel.startsWith("D");
    const isMonitored = monitoredChannels.has(channel);

    // For DMs: only monitor messages FROM other people TO the bot owner's DMs
    // (not the bot owner's own messages — those are handled by the main handler)
    if (isDM && user === config.slackUserId) return;

    if (!isDM && !isMonitored) return;

    const text = event.text ?? "";
    if (!text.trim()) return;

    const channelName = await resolveChannelName(client, channel);
    const threadTs = ("thread_ts" in event ? event.thread_ts : undefined) ?? event.ts;

    const ctx: MessageContext = {
      channel,
      channelName,
      user: user ?? "unknown",
      text,
      threadTs,
      ts: event.ts,
    };

    // Extract structured signals from the message (CRs, SIM tickets, URLs)
    const signals = extractSignals(text);

    if (signals.length > 0) {
      log.info("Listener detected signals", {
        channel: channelName ?? channel,
        user,
        signalCount: signals.length,
        types: [...new Set(signals.map((s) => s.type))],
      });

      // Process structured signals in parallel
      await Promise.allSettled(
        signals.map((signal) => processSignal(signal, ctx, store)),
      );
    }

    // For messages without structured signals (or in addition to them for DMs),
    // run intent classification to detect questions, requests, etc.
    // Only classify DMs and messages in monitored channels that look conversational.
    if (signals.length === 0 && (isDM || isMonitored)) {
      // Resolve user name for better classification context
      let userName: string | undefined;
      try {
        const userInfo = await client.users.info({ user: user! });
        userName = userInfo.user?.real_name ?? userInfo.user?.name;
      } catch {
        // Non-critical — classification works without it
      }

      const intent = await classifyIntent(text, { channelName, userName });
      if (intent) {
        log.info("Listener classified intent", {
          channel: channelName ?? channel,
          user: userName ?? user,
          type: intent.type,
          topic: intent.topic,
        });
        await processIntent(intent, ctx, store);
      }
    }
  });

  log.info("Passive listener installed");
  return { store, listenerConfig };
}
