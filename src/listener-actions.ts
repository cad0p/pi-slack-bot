/**
 * Listener actions — background preparation handlers for each signal type.
 *
 * Each action fetches external data and returns a briefing summary plus
 * any "discovered signals" found in the fetched content. Discovered signals
 * are registered in the store so they won't be fetched redundantly if they
 * appear later in other messages.
 *
 * These run asynchronously and never post to Slack.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { createLogger } from "./logger.js";
import { extractSignals, type Signal, type MessageContext } from "./listener-signals.js";
import { signalKey, type BriefingEntry, type BriefingStore, type SignalKey } from "./listener-store.js";

const log = createLogger("listener-actions");
const execFileAsync = promisify(execFile);

export interface ActionResult {
  summary: string;
  detail: string;
  /** Signals discovered inside the fetched content (e.g., CRs mentioned in a SIM ticket). */
  discoveredSignals?: SignalKey[];
}

type ActionHandler = (signal: Signal, ctx: MessageContext) => Promise<ActionResult | null>;

const ACTION_HANDLERS: Record<string, ActionHandler> = {
  cr: handleCR,
  sim: handleSIM,
  pipeline: handlePipeline,
  url: handleURL,
};

/**
 * Process a signal: check if already known (smart dedup), run the
 * appropriate background prep action, and store the result.
 */
export async function processSignal(
  signal: Signal,
  ctx: MessageContext,
  store: BriefingStore,
): Promise<void> {
  const handler = ACTION_HANDLERS[signal.type];
  if (!handler) {
    log.debug("No handler for signal type", { type: signal.type });
    return;
  }

  // Smart dedup: skip if this signal is already known — either stored
  // directly or discovered inside another entry's content.
  if (store.isKnown(signal.type, signal.id)) {
    const info = store.getKnownInfo(signal.type, signal.id);
    log.info("Skipping known signal", {
      type: signal.type,
      id: signal.id,
      source: info?.source,
      coveredBy: info?.parentKey,
    });
    return;
  }

  try {
    const result = await handler(signal, ctx);
    if (!result) return;

    const entry: BriefingEntry = {
      timestamp: new Date().toISOString(),
      channel: ctx.channel,
      channelName: ctx.channelName,
      user: ctx.user,
      signal,
      summary: result.summary,
      detail: result.detail,
      messageExcerpt: ctx.text.slice(0, 200),
      threadTs: ctx.threadTs,
      discoveredSignals: result.discoveredSignals,
    };

    store.add(entry);
  } catch (err) {
    log.error("Failed to process signal", { type: signal.type, id: signal.id, error: err });
  }
}

/** Run a command with timeout and return stdout. Returns null on failure. */
async function runCommand(
  cmd: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PATH: process.env.PATH },
    });
    return stdout.trim();
  } catch (err) {
    log.debug("Command failed", { cmd, args: args.slice(0, 2), error: err });
    return null;
  }
}

/**
 * Scan fetched content for signals that are now "covered" by this fetch.
 * Returns signal keys for dedup registration.
 */
function discoverSignalsInContent(content: string, excludeId: string): SignalKey[] {
  const found = extractSignals(content);
  return found
    .filter((s) => s.id !== excludeId)
    .map((s) => signalKey(s.type, s.id));
}

/** Fetch CR details using cr-reader skill script. */
async function handleCR(signal: Signal, _ctx: MessageContext): Promise<ActionResult | null> {
  log.info("Fetching CR details", { id: signal.id });

  const crScript = `${process.env.HOME}/.pi/agent/skills/cr-reader/scripts/cr-reader.sh`;
  const output = await runCommand("bash", [crScript, signal.id], 60_000);

  if (!output) {
    return {
      summary: `📋 CR ${signal.id} mentioned — could not fetch details`,
      detail: `CR URL: ${signal.url}\nFailed to fetch details automatically. You may want to review manually.`,
    };
  }

  // Scan CR details for embedded signals (e.g., SIM tickets in description)
  const discovered = discoverSignalsInContent(output, signal.id);
  if (discovered.length > 0) {
    log.info("Discovered signals in CR content", { cr: signal.id, discovered });
  }

  return {
    summary: `📋 CR ${signal.id} — pre-fetched review details`,
    detail: output.slice(0, 5000),
    discoveredSignals: discovered.length > 0 ? discovered : undefined,
  };
}

/** Fetch SIM ticket details using tickety. */
async function handleSIM(signal: Signal, _ctx: MessageContext): Promise<ActionResult | null> {
  log.info("Fetching SIM ticket", { id: signal.id });

  const output = await runCommand("tickety", ["get", signal.id], 30_000);

  if (!output) {
    return {
      summary: `🎫 SIM ${signal.id} mentioned — could not fetch details`,
      detail: `Ticket URL: ${signal.url}\nFailed to fetch details automatically.`,
    };
  }

  // Scan ticket content for embedded signals (e.g., CRs, other tickets, pipelines)
  const discovered = discoverSignalsInContent(output, signal.id);
  if (discovered.length > 0) {
    log.info("Discovered signals in SIM content", { sim: signal.id, discovered });
  }

  return {
    summary: `🎫 SIM ${signal.id} — pre-fetched ticket details`,
    detail: output.slice(0, 5000),
    discoveredSignals: discovered.length > 0 ? discovered : undefined,
  };
}

/** Fetch pipeline status. */
async function handlePipeline(signal: Signal, _ctx: MessageContext): Promise<ActionResult | null> {
  log.info("Noting pipeline reference", { id: signal.id });

  return {
    summary: `🚀 Pipeline ${signal.id} mentioned`,
    detail: `Pipeline URL: ${signal.url}\nReferenced in conversation — check status if relevant.`,
  };
}

/** Note interesting URL for later context. */
async function handleURL(signal: Signal, _ctx: MessageContext): Promise<ActionResult | null> {
  log.info("Noting URL reference", { url: signal.url });

  return {
    summary: `🔗 URL shared: ${signal.url}`,
    detail: `URL: ${signal.url}\nShared in conversation — content available for reference.`,
  };
}
