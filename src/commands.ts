import { resolve } from "path";
import { existsSync, statSync } from "fs";
import type { WebClient } from "@slack/web-api";
import type { ThreadSession } from "./thread-session.js";
import type { Pin, PinStore } from "./pin-store.js";
import type { BotSessionManager, ThreadSessionInfo } from "./session-manager.js";
import type { ThinkingLevel } from "./config.js";
import type { BriefingStore } from "./listener-store.js";
import { postPromptPicker } from "./command-picker.js";
import { postModelPicker } from "./model-picker.js";
import { postProjectSessionPicker, postToTuiCommand } from "./session-picker.js";
import { cancelSession, showDiff, compactSession } from "./session-actions.js";
import { formatContextUsage, formatContextBar } from "./context-format.js";

const VALID_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export interface CommandContext {
  channel: string;
  threadTs: string;
  client: WebClient;
  sessionManager: BotSessionManager;
  session: ThreadSession | undefined;
  pinStore: PinStore;
  briefingStore?: BriefingStore;
}

type CommandHandler = (ctx: CommandContext, args: string) => Promise<void>;

async function reply(ctx: CommandContext, text: string): Promise<void> {
  await ctx.client.chat.postMessage({
    channel: ctx.channel,
    thread_ts: ctx.threadTs,
    text,
  });
}

const handlers: Record<string, CommandHandler> = {
  async help(ctx) {
    const lines = [
      "*Commands:*",
      "`!help` — Show this list",
      "`!new` — Start a new session",
      "`!cancel` — Cancel the current stream",
      "`!status` — Show session info",
      "`!model <name>` — Switch model",
      "`!thinking <level>` — Set thinking level (off, minimal, low, medium, high, xhigh)",
      "`!sessions` — List active sessions",
      "`!cwd <path>` — Change working directory",
      "`!reload` — Reload extensions and prompt templates",
      "`!diff` — Show git diff of uncommitted changes",
      "`!compact` — Compact conversation to free context space",
      "`!context` — Show context window usage",
      "`!pin` — Pin the bot's last message in this thread",
      "`!pins` — List all pinned messages in this session",
      "`!restart` — Restart the bot process (sessions auto-restore)",
      "`!resume` — Browse and resume a local pi TUI session",
      "`!to-tui` — Get a command to open this Slack session in your terminal",
      "`!plan <idea>` — Start a PDD planning session",
      "`!prompt [name]` — Run a prompt template (shows picker if no args)",
      "`!briefing [days]` — Show prepared briefings from passive listener",
      "`!listen [status]` — Listener status and configuration help",
      "",
      "*File sharing:*",
      "• Upload files to a thread — they're saved to `.slack-files/` in the session cwd",
      "• The agent can share files back via the `share_file` tool",
      "",
      "Any other `!command` is forwarded to pi as `/command` (extensions & prompt templates).",
    ];
    await reply(ctx, lines.join("\n"));
  },

  async new(ctx) {
    if (!ctx.session) {
      await reply(ctx, "No active session.");
      return;
    }
    await ctx.session.newSession();
    await reply(ctx, "🆕 New session started.");
  },

  async cancel(ctx) {
    if (!ctx.session) {
      await reply(ctx, "No active session.");
      return;
    }
    await cancelSession(ctx.session, (text) => reply(ctx, text));
  },

  async status(ctx) {
    if (!ctx.session) {
      await reply(ctx, "No active session.");
      return;
    }
    const s = ctx.session;
    const lines = [
      `*Model:* ${s.model?.id ?? "unknown"}`,
      `*Thinking:* ${s.thinkingLevel}`,
      `*Messages:* ${s.messageCount}`,
      `*CWD:* \`${s.cwd}\``,
      `*Last activity:* ${s.lastActivity.toISOString()}`,
    ];
    const usage = s.getContextUsage();
    if (usage) {
      lines.push(`*Context:* ${formatContextUsage(usage)}`);
    }
    await reply(ctx, lines.join("\n"));
  },

  async model(ctx, args) {
    if (!ctx.session) {
      await reply(ctx, "No active session.");
      return;
    }
    const modelName = args.trim();
    if (!modelName) {
      // No args — show interactive model picker
      await postModelPicker(ctx.client, ctx.channel, ctx.threadTs, ctx.session);
      return;
    }
    try {
      await ctx.session.setModel(modelName);
      await reply(ctx, `✅ Model set to \`${modelName}\`.`);
    } catch (err) {
      await reply(ctx, `❌ ${err instanceof Error ? err.message : String(err)}`);
    }
  },

  async thinking(ctx, args) {
    if (!ctx.session) {
      await reply(ctx, "No active session.");
      return;
    }
    const level = args.trim() as ThinkingLevel;
    if (!VALID_THINKING_LEVELS.includes(level)) {
      await reply(ctx, `❌ Invalid level. Must be one of: ${VALID_THINKING_LEVELS.join(", ")}`);
      return;
    }
    ctx.session.setThinkingLevel(level);
    await reply(ctx, `✅ Thinking level set to \`${level}\`.`);
  },

  async sessions(ctx) {
    const list = ctx.sessionManager.list();
    if (list.length === 0) {
      await reply(ctx, "No active sessions.");
      return;
    }
    const rows = list.map((s: ThreadSessionInfo) =>
      `• \`${s.threadTs}\` — ${s.model} | ${s.messageCount} msgs | \`${s.cwd}\` | ${s.isStreaming ? "🔴 streaming" : "⚪ idle"}`
    );
    await reply(ctx, rows.join("\n"));
  },

  async cwd(ctx, args) {
    const target = args.trim();
    if (!target) {
      if (!ctx.session) {
        await reply(ctx, "No active session.");
      } else {
        await reply(ctx, `Current cwd: \`${ctx.session.cwd}\``);
      }
      return;
    }
    const resolved = resolve(target);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      await reply(ctx, `❌ Not a valid directory: \`${resolved}\``);
      return;
    }

    // Tear down old session and create a new one so the ResourceLoader,
    // AGENTS.md, project .pi/ extensions & prompts all pick up the new cwd.
    if (ctx.session) {
      await ctx.sessionManager.dispose(ctx.threadTs);
    }
    await ctx.sessionManager.getOrCreate({
      threadTs: ctx.threadTs,
      channelId: ctx.channel,
      cwd: resolved,
    });
    await reply(ctx, `📂 New session in \`${resolved}\`. Project AGENTS.md, extensions, and prompts loaded.`);
  },

  async reload(ctx) {
    if (!ctx.session) {
      await reply(ctx, "No active session.");
      return;
    }
    await ctx.session.reload();
    await reply(ctx, "🔄 Extensions and prompt templates reloaded.");
  },

  async restart(ctx) {
    await reply(ctx, "♻️ Restarting bot... sessions will auto-restore.");
    // Flush registry so sessions survive the restart, then exit with
    // code 75 which run.sh interprets as "restart requested".
    await ctx.sessionManager.flushRegistry();
    setTimeout(() => process.exit(75), 500);
  },

  async plan(ctx, args) {
    if (!ctx.session) {
      await reply(ctx, "No active session. Send a message first to start one.");
      return;
    }
    const trimmed = args.trim();
    if (trimmed) {
      // Forward directly: !plan build a rate limiter → /plan build a rate limiter
      ctx.session.enqueue(() => ctx.session!.prompt(`/plan ${trimmed}`));
    } else {
      await reply(ctx, "Usage: `!plan <idea>` — e.g. `!plan build a rate limiter for our API`\n\nThis starts a PDD (Prompt-Driven Development) planning session that transforms your rough idea into a detailed design with an implementation plan.");
    }
  },

  async resume(ctx) {
    await postProjectSessionPicker(ctx.client, ctx.channel, ctx.threadTs, ctx.sessionManager);
  },

  async "to-tui"(ctx) {
    await postToTuiCommand(ctx.client, ctx.channel, ctx.threadTs, ctx.session, ctx.sessionManager.sessionDir);
  },

  async diff(ctx) {
    if (!ctx.session) {
      await reply(ctx, "No active session.");
      return;
    }
    await showDiff(ctx.session, (text) => reply(ctx, text), ctx.client, ctx.channel, ctx.threadTs);
  },

  async compact(ctx) {
    if (!ctx.session) {
      await reply(ctx, "No active session.");
      return;
    }
    await compactSession(ctx.session, (text) => reply(ctx, text));
  },

  async context(ctx) {
    if (!ctx.session) {
      await reply(ctx, "No active session.");
      return;
    }
    const usage = ctx.session.getContextUsage();
    if (!usage) {
      await reply(ctx, "Context usage not available yet.");
      return;
    }
    const lines = [
      "*Context Window*",
      `\`${formatContextBar(usage.percent ?? 0)}\``,
      `*Tokens:* ${formatContextUsage(usage)}`,
      `*Model:* ${ctx.session.model?.id ?? "unknown"}`,
      "",
      "Use `!compact` to free space or `!new` for a fresh session.",
    ];
    await reply(ctx, lines.join("\n"));
  },

  async pin(ctx) {
    try {
      // Get bot's own user ID
      const authResult = await ctx.client.auth.test();
      const botUserId = authResult.user_id;

      // Fetch thread messages and find the most recent bot message
      const result = await ctx.client.conversations.replies({
        channel: ctx.channel,
        ts: ctx.threadTs,
        limit: 50,
      });
      const messages = result.messages ?? [];
      const botMsg = [...messages].reverse().find((m) => m.user === botUserId);
      if (!botMsg || !botMsg.ts) {
        await reply(ctx, "No bot message found to pin.");
        return;
      }

      const permalinkResult = await ctx.client.chat.getPermalink({
        channel: ctx.channel,
        message_ts: botMsg.ts,
      });

      const text = botMsg.text ?? "";
      const preview = text.length > 150 ? text.slice(0, 150) + "…" : text;
      const pin: Pin = {
        timestamp: new Date().toISOString(),
        preview,
        permalink: permalinkResult.permalink ?? "",
        channelId: ctx.channel,
        threadTs: ctx.threadTs,
      };
      ctx.pinStore.add(pin);
      await reply(ctx, `📌 Pinned: "${preview}"`);
    } catch (err) {
      await reply(ctx, `❌ Failed to pin: ${err instanceof Error ? err.message : String(err)}`);
    }
  },

  async pins(ctx) {
    const pins = ctx.pinStore.all;
    if (pins.length === 0) {
      await reply(ctx, "No pinned messages.");
      return;
    }
    const lines = pins.map((p: Pin, i: number) =>
      `${i + 1}. ${p.preview}\n   <${p.permalink}|View message> — ${new Date(p.timestamp).toLocaleTimeString()}`
    );
    await reply(ctx, `*📌 Pinned messages (${pins.length}):*\n${lines.join("\n")}`);
  },

  async prompt(ctx, args) {
    if (!ctx.session) {
      await reply(ctx, "No active session. Send a message first to start one.");
      return;
    }
    const trimmed = args.trim();
    if (trimmed) {
      // Forward directly: !prompt review → /review
      ctx.session.enqueue(() => ctx.session!.prompt(`/${trimmed}`));
    } else {
      // No args — show template picker buttons
      await postPromptPicker(ctx.client, ctx.channel, ctx.threadTs, ctx.session);
    }
  },

  async briefing(ctx, args) {
    if (!ctx.briefingStore) {
      await reply(ctx, "❌ Listener is not enabled. Configure `~/.pi-slack-bot/listener.json` first.");
      return;
    }

    const days = parseInt(args.trim(), 10) || 1;
    const entries = ctx.briefingStore.getRecent(days);

    if (entries.length === 0) {
      await reply(ctx, `No briefings in the last ${days} day(s). The listener monitors configured channels and prepares context when it detects CRs, SIM tickets, etc.`);
      return;
    }

    const lines = [`*📋 Briefings (${entries.length} items, last ${days} day(s)):*`, ""];
    for (const entry of entries.slice(0, 20)) {
      const time = new Date(entry.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      const channel = entry.channelName ? `#${entry.channelName}` : entry.channel;
      lines.push(`*${time}* — ${channel}`);
      lines.push(`  ${entry.summary}`);
      if (entry.detail.length > 200) {
        lines.push(`  _${entry.detail.slice(0, 200)}…_`);
      } else {
        lines.push(`  _${entry.detail}_`);
      }
      lines.push("");
    }

    if (entries.length > 20) {
      lines.push(`_…and ${entries.length - 20} more_`);
    }

    await reply(ctx, lines.join("\n"));
  },

  async listen(ctx, args) {
    const sub = args.trim().toLowerCase();

    if (sub === "status") {
      if (!ctx.briefingStore) {
        await reply(ctx, "Listener: *disabled*\nConfigure `~/.pi-slack-bot/listener.json` to enable.");
        return;
      }
      const count = ctx.briefingStore.getTodayCount();
      const dates = ctx.briefingStore.listDates();
      await reply(ctx, [
        "Listener: *enabled* ✅",
        `Today's briefings: ${count}`,
        `Days with data: ${dates.length}`,
        "",
        "Use `!briefing` to see prepared context.",
        "Use `!briefing 3` for last 3 days.",
      ].join("\n"));
      return;
    }

    await reply(ctx, [
      "*Passive Listener Commands:*",
      "`!listen status` — Show listener status",
      "`!briefing` — Show today's prepared briefings",
      "`!briefing <days>` — Show briefings from last N days",
      "",
      "*Configuration:*",
      "Edit `~/.pi-slack-bot/listener.json`:",
      "```",
      JSON.stringify({
        enabled: true,
        channels: ["C01234ABCDE"],
      }, null, 2),
      "```",
      "Channel IDs can be found in Slack channel details.",
      "DMs from others are always monitored when enabled.",
    ].join("\n"));
  },
};

/**
 * Parse a `!command args` string. Returns null if not a command.
 */
export function parseCommand(text: string): { name: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("!")) return null;
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    return { name: trimmed.slice(1).toLowerCase(), args: "" };
  }
  return {
    name: trimmed.slice(1, spaceIdx).toLowerCase(),
    args: trimmed.slice(spaceIdx + 1),
  };
}

/**
 * Dispatch a parsed command. Returns true if handled, false if unknown.
 * Unknown commands are forwarded to the pi session as /command.
 */
export async function dispatchCommand(
  name: string,
  args: string,
  ctx: CommandContext,
): Promise<boolean> {
  const handler = handlers[name];
  if (handler) {
    await handler(ctx, args);
    return true;
  }

  // Unknown bot command → forward to pi session as /command
  if (ctx.session) {
    const piCommand = args ? `/${name} ${args}` : `/${name}`;
    ctx.session.enqueue(() => ctx.session!.prompt(piCommand));
    return true;
  }

  await reply(ctx, `No active session. Send a message first to start one, then use \`!${name}\`.`);
  return false;
}
