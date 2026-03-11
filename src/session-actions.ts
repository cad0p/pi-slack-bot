/**
 * Shared session actions used by both !commands and emoji reactions.
 *
 * Each action takes a session and a reply function, keeping them
 * independent of the Slack API surface (commands.ts provides `reply(ctx, ...)`,
 * reactions.ts provides `client.chat.postMessage(...)`).
 */
import type { ThreadSession } from "./thread-session.js";
import { postDiffReview } from "./diff-reviewer.js";
import { formatTokenCount } from "./context-format.js";
import type { WebClient } from "@slack/web-api";

/** A function that posts a message to the thread. */
export type ReplyFn = (text: string) => Promise<void>;

/**
 * Cancel the current agent stream.
 */
export function cancelSession(session: ThreadSession, reply: ReplyFn): Promise<void> {
  session.abort();
  return reply("🛑 Cancelled.");
}

/**
 * Show a git diff review for the session's working directory.
 */
export async function showDiff(
  session: ThreadSession,
  reply: ReplyFn,
  client: WebClient,
  channel: string,
  threadTs: string,
): Promise<void> {
  const posted = await postDiffReview(client, channel, threadTs, session.cwd, {
    pasteProvider: session.pasteProvider,
  });
  if (!posted) {
    await reply("No uncommitted changes found (or not a git repo).");
  }
}

/**
 * Compact the conversation context window.
 */
export async function compactSession(session: ThreadSession, reply: ReplyFn): Promise<void> {
  if (session.isStreaming) {
    await reply("❌ Can't compact while streaming. Wait for the current turn to finish.");
    return;
  }
  await reply("🗜️ Compacting conversation...");
  try {
    const result = await session.compact();
    const afterUsage = session.getContextUsage();
    const beforeStr = formatTokenCount(result.tokensBefore);
    const afterStr = afterUsage?.tokens != null ? formatTokenCount(afterUsage.tokens) : "unknown";
    await reply(`🗜️ Compacted: ${beforeStr} → ${afterStr} tokens`);
  } catch (err) {
    await reply(`❌ Compaction failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
