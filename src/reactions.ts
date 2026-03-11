/**
 * Reaction-based interactions — map emoji reactions to bot commands.
 *
 * Users can react to messages in a bot thread to trigger actions
 * without typing commands. The reaction is removed after handling
 * to provide visual feedback.
 */
import type { WebClient } from "@slack/web-api";
import type { ThreadSession } from "./thread-session.js";
import { cancelSession, showDiff, compactSession } from "./session-actions.js";
import { createLogger } from "./logger.js";

const log = createLogger("reactions");

/** Map of Slack emoji names to action identifiers. */
export const REACTION_MAP: Record<string, string> = {
  x: "cancel",
  arrows_counterclockwise: "retry",
  clipboard: "diff",
  clamp: "compact",
};

/**
 * Handle a reaction on a message in a bot thread.
 *
 * @returns true if the reaction was handled, false if the emoji is not mapped.
 */
export async function handleReaction(
  emoji: string,
  session: ThreadSession,
  client: WebClient,
  channel: string,
  threadTs: string,
): Promise<boolean> {
  const action = REACTION_MAP[emoji];
  if (!action) return false;

  log.info("Handling reaction", { emoji, action, threadTs });

  const reply = async (text: string) => {
    await client.chat.postMessage({ channel, thread_ts: threadTs, text });
  };

  switch (action) {
    case "cancel":
      await cancelSession(session, reply);
      break;

    case "retry": {
      const lastPrompt = session.lastUserPrompt;
      if (!lastPrompt) {
        await reply("No previous prompt to retry.");
        return true;
      }
      await reply(`🔄 Retrying: ${lastPrompt.length > 100 ? lastPrompt.slice(0, 100) + "…" : lastPrompt}`);
      session.enqueue(() => session.prompt(lastPrompt));
      break;
    }

    case "diff":
      await showDiff(session, reply, client, channel, threadTs);
      break;

    case "compact":
      await compactSession(session, reply);
      break;
  }

  return true;
}
