/**
 * Signal extraction from Slack messages.
 *
 * Parses messages for actionable items (CR links, SIM tickets, URLs, etc.)
 * without responding. These signals drive background preparation.
 */

import { createLogger } from "./logger.js";

const log = createLogger("listener-signals");

export type SignalType = "cr" | "sim" | "pipeline" | "url" | "mention";

export interface Signal {
  type: SignalType;
  /** The raw matched text */
  raw: string;
  /** Extracted identifier (e.g. CR ID, SIM ticket ID) */
  id: string;
  /** Optional URL if one was extracted */
  url?: string;
}

export interface MessageContext {
  channel: string;
  channelName?: string;
  user: string;
  text: string;
  threadTs: string;
  ts: string;
}

/** Extract all actionable signals from a message. */
export function extractSignals(text: string): Signal[] {
  const signals: Signal[] = [];

  signals.push(...extractCRSignals(text));
  signals.push(...extractSIMSignals(text));
  signals.push(...extractPipelineSignals(text));
  signals.push(...extractURLSignals(text));

  if (signals.length > 0) {
    log.debug("Extracted signals", { count: signals.length, types: signals.map((s) => s.type) });
  }

  return signals;
}

/** CR links: https://code.amazon.com/reviews/CR-12345678 or just CR-12345678 */
function extractCRSignals(text: string): Signal[] {
  const signals: Signal[] = [];
  const seen = new Set<string>();

  // Full URL form
  const urlPattern = /https:\/\/code\.amazon\.com\/reviews\/(CR-\d+)/gi;
  for (const match of text.matchAll(urlPattern)) {
    const id = match[1].toUpperCase();
    if (!seen.has(id)) {
      seen.add(id);
      signals.push({ type: "cr", raw: match[0], id, url: match[0] });
    }
  }

  // Bare CR-NNNN references
  const barePattern = /\b(CR-\d{5,})\b/gi;
  for (const match of text.matchAll(barePattern)) {
    const id = match[1].toUpperCase();
    if (!seen.has(id)) {
      seen.add(id);
      signals.push({
        type: "cr",
        raw: match[0],
        id,
        url: `https://code.amazon.com/reviews/${id}`,
      });
    }
  }

  return signals;
}

/** SIM tickets: t.corp/V123456789, SIM-V123456789, tt/V123456789, issues.amazon.com links */
function extractSIMSignals(text: string): Signal[] {
  const signals: Signal[] = [];
  const seen = new Set<string>();

  // t.corp links
  const tcorpPattern = /t\.corp\/([\w-]+)/gi;
  for (const match of text.matchAll(tcorpPattern)) {
    const id = match[1];
    if (!seen.has(id)) {
      seen.add(id);
      signals.push({ type: "sim", raw: match[0], id, url: `https://t.corp.amazon.com/${id}` });
    }
  }

  // issues.amazon.com links
  const issuesPattern = /https:\/\/issues\.amazon\.com\/issues\/([\w-]+)/gi;
  for (const match of text.matchAll(issuesPattern)) {
    const id = match[1];
    if (!seen.has(id)) {
      seen.add(id);
      signals.push({ type: "sim", raw: match[0], id, url: match[0] });
    }
  }

  // tt/ shorthand
  const ttPattern = /\btt\/([\w-]+)/gi;
  for (const match of text.matchAll(ttPattern)) {
    const id = match[1];
    if (!seen.has(id)) {
      seen.add(id);
      signals.push({ type: "sim", raw: match[0], id, url: `https://t.corp.amazon.com/${id}` });
    }
  }

  return signals;
}

/** Pipeline references */
function extractPipelineSignals(text: string): Signal[] {
  const signals: Signal[] = [];
  const seen = new Set<string>();

  // pipelines.amazon.com links
  const pipelinePattern = /https:\/\/pipelines\.amazon\.com\/pipelines\/([\w-]+)/gi;
  for (const match of text.matchAll(pipelinePattern)) {
    const id = match[1];
    if (!seen.has(id)) {
      seen.add(id);
      signals.push({ type: "pipeline", raw: match[0], id, url: match[0] });
    }
  }

  return signals;
}

/** General interesting URLs (wiki pages, quip docs, etc.) — excluding already-matched patterns */
function extractURLSignals(text: string): Signal[] {
  const signals: Signal[] = [];
  const seen = new Set<string>();

  // Wiki pages
  const wikiPattern = /https:\/\/w\.amazon\.com\/bin\/view\/([\w/]+)/gi;
  for (const match of text.matchAll(wikiPattern)) {
    const id = match[1];
    if (!seen.has(match[0])) {
      seen.add(match[0]);
      signals.push({ type: "url", raw: match[0], id, url: match[0] });
    }
  }

  // Quip docs
  const quipPattern = /https:\/\/quip-amazon\.com\/([\w-]+)/gi;
  for (const match of text.matchAll(quipPattern)) {
    const id = match[1];
    if (!seen.has(match[0])) {
      seen.add(match[0]);
      signals.push({ type: "url", raw: match[0], id, url: match[0] });
    }
  }

  return signals;
}
