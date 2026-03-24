/**
 * Intent-based preparation actions.
 *
 * When the listener classifies a message as a question, action request,
 * or status ask, this module runs targeted prep based on the LLM's
 * suggested hints and extracted entities.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { createLogger } from "./logger.js";
import type { ClassifiedIntent } from "./listener-intent.js";
import type { MessageContext } from "./listener-signals.js";
import { BriefingStore } from "./listener-store.js";

const log = createLogger("listener-intent-actions");
const execFileAsync = promisify(execFile);

const INTENT_EMOJI: Record<string, string> = {
  question: "❓",
  action_request: "📝",
  status_ask: "📊",
  meeting_prep: "📅",
  fyi: "ℹ️",
};

/** Run a command with timeout and return stdout. */
async function runCommand(cmd: string, args: string[], timeoutMs = 30_000): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PATH: process.env.PATH },
    });
    return stdout.trim();
  } catch (err) {
    log.debug("Command failed", { cmd, error: err });
    return null;
  }
}

interface PrepResult {
  source: string;
  content: string;
}

/**
 * Execute prep hints from the LLM classification.
 * Each hint is a natural language instruction like "search vault for [topic]".
 */
async function executePrepHints(hints: string[], entities: string[]): Promise<PrepResult[]> {
  const results: PrepResult[] = [];
  const tasks: Promise<void>[] = [];

  for (const hint of hints.slice(0, 5)) { // Cap at 5 hints
    const lowerHint = hint.toLowerCase();

    if (lowerHint.includes("search vault") || lowerHint.includes("vault search") || lowerHint.includes("vault for")) {
      tasks.push(searchVault(hint, entities).then((r) => { if (r) results.push(r); }));
    } else if (lowerHint.includes("check recent cr") || lowerHint.includes("look up cr")) {
      tasks.push(searchRecentCRs(entities).then((r) => { if (r) results.push(r); }));
    } else if (lowerHint.includes("sim ticket") || lowerHint.includes("look up sim")) {
      tasks.push(searchTickets(entities).then((r) => { if (r) results.push(r); }));
    } else if (lowerHint.includes("pipeline") || lowerHint.includes("deployment")) {
      results.push({ source: "hint", content: `Pipeline check suggested: ${hint}` });
    } else if (lowerHint.includes("calendar") || lowerHint.includes("meeting")) {
      tasks.push(checkCalendar(entities).then((r) => { if (r) results.push(r); }));
    } else if (lowerHint.includes("person") || lowerHint.includes("look up")) {
      // Generic lookup — try vault search
      tasks.push(searchVault(hint, entities).then((r) => { if (r) results.push(r); }));
    } else {
      // Fallback: vault search with the hint text
      tasks.push(searchVault(hint, entities).then((r) => { if (r) results.push(r); }));
    }
  }

  await Promise.allSettled(tasks);
  return results;
}

/** Search the vault for relevant context. */
async function searchVault(hint: string, entities: string[]): Promise<PrepResult | null> {
  // Extract search terms from the hint and entities
  const searchTerms = entities.length > 0 ? entities.join(" ") : hint;

  // Use grep across vault for matching content
  const output = await runCommand("bash", [
    "-c",
    `cd ~/vault && grep -r -l -i "${searchTerms.replace(/"/g, '\\"').slice(0, 100)}" --include="*.md" 2>/dev/null | head -10`,
  ], 10_000);

  if (!output) return null;

  const files = output.split("\n").filter(Boolean);
  if (files.length === 0) return null;

  // Read excerpts from matching files
  const excerpts: string[] = [];
  for (const file of files.slice(0, 3)) {
    const content = await runCommand("bash", [
      "-c",
      `cd ~/vault && head -30 "${file}" 2>/dev/null`,
    ], 5_000);
    if (content) {
      excerpts.push(`--- ${file} ---\n${content.slice(0, 500)}`);
    }
  }

  if (excerpts.length === 0) return null;

  return {
    source: "vault",
    content: `Found ${files.length} vault notes matching "${searchTerms}":\n\n${excerpts.join("\n\n")}`,
  };
}

/** Search for recent CRs related to entities. */
async function searchRecentCRs(entities: string[]): Promise<PrepResult | null> {
  if (entities.length === 0) return null;

  // Look for recent CR references in git logs
  const results: string[] = [];
  for (const entity of entities.slice(0, 3)) {
    const output = await runCommand("bash", [
      "-c",
      `cd ~/vault && grep -r -i "CR-" --include="*.md" -l 2>/dev/null | xargs grep -l -i "${entity.replace(/"/g, '\\"')}" 2>/dev/null | head -3`,
    ], 10_000);
    if (output) results.push(`CRs related to "${entity}": ${output}`);
  }

  if (results.length === 0) return null;
  return { source: "cr-search", content: results.join("\n") };
}

/** Search for SIM tickets related to entities. */
async function searchTickets(entities: string[]): Promise<PrepResult | null> {
  if (entities.length === 0) return null;

  const output = await runCommand("bash", [
    "-c",
    `cd ~/vault && grep -r -i "t\\.corp\\|SIM\\|V[0-9]\\{9\\}" --include="*.md" 2>/dev/null | grep -i "${entities[0].replace(/"/g, '\\"')}" | head -10`,
  ], 10_000);

  if (!output) return null;
  return { source: "ticket-search", content: `Ticket references: ${output.slice(0, 1000)}` };
}

/** Check calendar for relevant meetings. */
async function checkCalendar(_entities: string[]): Promise<PrepResult | null> {
  // Use outlook-mcp if available
  const MCP = `${process.env.HOME}/.pi/agent/bin/mcp-call.js --server aws-outlook-mcp`;
  const output = await runCommand("bash", [
    "-c",
    `${MCP} get_calendar_events '{"startDate":"today","endDate":"tomorrow"}' 2>/dev/null`,
  ], 15_000);

  if (!output) return null;
  return { source: "calendar", content: `Today's calendar:\n${output.slice(0, 2000)}` };
}

/**
 * Process a classified intent: run prep actions and store the briefing.
 */
export async function processIntent(
  intent: ClassifiedIntent,
  ctx: MessageContext,
  store: BriefingStore,
): Promise<void> {
  const emoji = INTENT_EMOJI[intent.type] ?? "💭";

  log.info("Processing intent", {
    type: intent.type,
    topic: intent.topic,
    hintCount: intent.prepHints.length,
    entityCount: intent.entities.length,
  });

  // Run prep based on hints
  const prepResults = await executePrepHints(intent.prepHints, intent.entities);

  // Build the detail from prep results
  const detailParts: string[] = [
    `**Intent:** ${intent.type} (confidence: ${(intent.confidence * 100).toFixed(0)}%)`,
    `**Topic:** ${intent.topic}`,
  ];

  if (intent.entities.length > 0) {
    detailParts.push(`**Entities:** ${intent.entities.join(", ")}`);
  }

  if (prepResults.length > 0) {
    detailParts.push("", "**Prepared Context:**");
    for (const r of prepResults) {
      detailParts.push(`\n[${r.source}]\n${r.content}`);
    }
  } else {
    detailParts.push("", "_No additional context found — you may need to gather this manually._");
  }

  const summary = `${emoji} ${intent.type}: "${intent.topic}"`;

  store.add({
    timestamp: new Date().toISOString(),
    channel: ctx.channel,
    channelName: ctx.channelName,
    user: ctx.user,
    signal: {
      type: "mention" as const,
      raw: ctx.text.slice(0, 200),
      id: `intent-${Date.now()}`,
    },
    summary,
    detail: detailParts.join("\n").slice(0, 8000),
    messageExcerpt: ctx.text.slice(0, 200),
    threadTs: ctx.threadTs,
  });
}
