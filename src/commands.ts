import { resolve } from "path";
import { existsSync, statSync } from "fs";
import type { WebClient } from "@slack/web-api";
import type { ThreadSession } from "./thread-session.js";
import type { BotSessionManager, ThreadSessionInfo } from "./session-manager.js";
import type { ThinkingLevel } from "./config.js";
import { postRalphPicker, postPromptPicker } from "./command-picker.js";
import { postProjectSessionPicker, postToTuiCommand } from "./session-picker.js";
import { postDiffReview } from "./diff-reviewer.js";

const VALID_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export interface CommandContext {
  channel: string;
  threadTs: string;
  client: WebClient;
  sessionManager: BotSessionManager;
  session: ThreadSession | undefined;
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
      "`!restart` — Restart the bot process (sessions auto-restore)",
      "`!resume` — Browse and resume a local pi TUI session",
      "`!to-tui` — Get a command to open this Slack session in your terminal",
      "`!ralph [preset] [prompt]` — Start a Ralph loop (shows preset picker if no args)",
      "`!ralph status` — Show current loop state",
      "`!ralph pause` / `!ralph resume` — Pause or resume the active loop",
      "`!ralph steer <msg>` — Queue guidance for the next iteration",
      "`!ralph stop` — Stop the active loop",
      "`!ralph presets` — List available presets",
      "`!plan <idea>` — Start a PDD planning session",
      "`!prompt [name]` — Run a prompt template (shows picker if no args)",
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
    ctx.session.abort();
    await reply(ctx, "🛑 Cancelled.");
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
    await reply(ctx, lines.join("\n"));
  },

  async model(ctx, args) {
    if (!ctx.session) {
      await reply(ctx, "No active session.");
      return;
    }
    const modelName = args.trim();
    if (!modelName) {
      await reply(ctx, `Current model: ${ctx.session.model?.id ?? "unknown"}`);
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
    const session = await ctx.sessionManager.getOrCreate({
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

  async ralph(ctx, args) {
    if (!ctx.session) {
      await reply(ctx, "No active session. Send a message first to start one.");
      return;
    }
    const trimmed = args.trim();
    if (trimmed) {
      // Forward directly: !ralph feature build X → /ralph feature build X
      ctx.session.enqueue(() => ctx.session!.prompt(`/ralph ${trimmed}`));
    } else {
      // No args — show preset picker buttons
      await postRalphPicker(ctx.client, ctx.channel, ctx.threadTs, ctx.session);
    }
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
    const posted = await postDiffReview(ctx.client, ctx.channel, ctx.threadTs, ctx.session.cwd, {
      pasteProvider: ctx.session.pasteProvider,
    });
    if (!posted) {
      await reply(ctx, "No uncommitted changes found (or not a git repo).");
    }
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
