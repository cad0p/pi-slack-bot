/**
 * Intent classification for listener messages.
 *
 * Uses a lightweight Bedrock LLM call to classify messages that don't
 * contain structured signals (CRs, SIM tickets, etc.) but may contain
 * questions, requests, or topics worth preparing context for.
 *
 * Key constraint: this is a classification-only call — fast and cheap.
 * The actual prep work is done by listener-actions.
 */

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { createLogger } from "./logger.js";

const log = createLogger("listener-intent");

/** The Bedrock model used for lightweight classification. Haiku is fast & cheap. */
const CLASSIFY_MODEL = "anthropic.claude-3-5-haiku-20241022-v1:0";

export type IntentType =
  | "question"        // Someone is asking the user a question
  | "action_request"  // Someone wants the user to do something
  | "status_ask"      // Someone asks about project/task status
  | "meeting_prep"    // Reference to an upcoming meeting or discussion
  | "fyi"             // Informational — no response needed but worth noting
  | "noise";          // Small talk, greetings, not actionable

export interface ClassifiedIntent {
  type: IntentType;
  /** Confidence 0-1 */
  confidence: number;
  /** What the person is asking/requesting, in a concise phrase */
  topic: string;
  /** Suggested prep actions — what context to gather */
  prepHints: string[];
  /** Key entities extracted (project names, people, dates, etc.) */
  entities: string[];
}

let _client: BedrockRuntimeClient | null = null;

function getClient(): BedrockRuntimeClient {
  if (!_client) {
    _client = new BedrockRuntimeClient({
      region: process.env.AWS_REGION ?? "us-west-2",
      // Uses AWS_PROFILE from env (set to "claude" in .env)
    });
  }
  return _client;
}

const SYSTEM_PROMPT = `You classify Slack messages directed at or relevant to a software engineer ("the user"). Your job is to identify whether a message needs background preparation.

Respond with JSON only. No markdown, no explanation.

Schema:
{
  "type": "question" | "action_request" | "status_ask" | "meeting_prep" | "fyi" | "noise",
  "confidence": 0.0-1.0,
  "topic": "concise description of what's being asked/requested",
  "prepHints": ["specific things to look up to prepare a response"],
  "entities": ["project names", "people", "services", "dates mentioned"]
}

Intent types:
- question: Someone is asking the user a direct question that needs an answer
- action_request: Someone wants the user to do something (review code, fix a bug, join a meeting, etc.)
- status_ask: Someone is asking about the status of a project, task, deployment, or initiative
- meeting_prep: Message references an upcoming meeting, 1:1, or discussion topic
- fyi: Informational message — no response needed but the topic is worth noting for context
- noise: Greetings, small talk, emoji-only, automated messages, not actionable

For prepHints, suggest specific lookups like:
- "search vault for [topic]"
- "check recent CRs for [package]"
- "look up SIM tickets for [project]"  
- "check pipeline status for [service]"
- "find recent commits in [repo]"
- "check calendar for [meeting]"
- "look up person [name]"

Be conservative — only classify as question/action_request/status_ask if there's a clear intent directed at the user. General channel chatter is "fyi" or "noise".`;

/**
 * Classify a message's intent using a lightweight LLM call.
 * Returns null if classification fails or the message is noise.
 */
export async function classifyIntent(
  text: string,
  context?: { channelName?: string; userName?: string },
): Promise<ClassifiedIntent | null> {
  // Skip very short messages or obvious noise
  if (text.length < 10) return null;
  if (/^(hi|hey|hello|thanks|ty|thx|lol|😂|👍|🎉|\+1)$/i.test(text.trim())) return null;

  const userMsg = context?.channelName
    ? `[Channel: #${context.channelName}] [From: ${context.userName ?? "unknown"}]\n\n${text}`
    : `[From: ${context?.userName ?? "unknown"}]\n\n${text}`;

  try {
    const client = getClient();
    const command = new InvokeModelCommand({
      modelId: CLASSIFY_MODEL,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 512,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMsg }],
      }),
    });

    const response = await client.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    const content = responseBody.content?.[0]?.text;

    if (!content) {
      log.debug("Empty LLM response for classification");
      return null;
    }

    const parsed = JSON.parse(content) as ClassifiedIntent;

    // Validate the response shape
    if (!parsed.type || !parsed.topic) {
      log.debug("Invalid classification response", { content });
      return null;
    }

    // Filter out noise and low-confidence results
    if (parsed.type === "noise") return null;
    if (parsed.confidence < 0.5) return null;

    log.info("Classified intent", {
      type: parsed.type,
      confidence: parsed.confidence,
      topic: parsed.topic,
      entityCount: parsed.entities?.length ?? 0,
    });

    return parsed;
  } catch (err) {
    log.error("Intent classification failed", { error: err });
    return null;
  }
}
