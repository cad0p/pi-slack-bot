import { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { basename } from "path";
import { homedir } from "os";
import type { Config } from "./config.js";
import { BotSessionManager, SessionLimitError } from "./session-manager.js";
import { parseMessage, loadProjects, projectPaths, type Project } from "./parser.js";
import { parseCommand, dispatchCommand } from "./commands.js";
import type { AttachServer } from "./attach-server.js";
import { handleFileSelect, handleFileNav, handleFilePickCancel, getPendingPick } from "./file-picker.js";
import {
  handleRalphPresetSelect,
  handlePromptSelect,
  tryConsumeRalphPrompt,
} from "./command-picker.js";
import {
  handleResumeProjectSelect,
  handleResumeSessionSelect,
} from "./session-picker.js";
import {
  downloadSlackFiles,
  formatInboundFileContext,
  type SlackFile,
} from "./file-sharing.js";

/**
 * If the message has attached files, download them into the cwd and
 * prepend context about them to the prompt text.
 */
async function enrichPromptWithFiles(
  files: SlackFile[],
  text: string,
  cwd: string,
  botToken: string,
): Promise<string> {
  if (files.length === 0) return text;

  const downloaded = await downloadSlackFiles(files, cwd, botToken);
  const context = formatInboundFileContext(downloaded);
  if (!context) return text;

  return text ? `${context}\n\n${text}` : context;
}

export interface PendingCwd {
  threadTs: string;
  channelId: string;
  prompt: string;
  /** Files the user shared with this message, pending download after cwd is selected. */
  files: SlackFile[];
}

/** Slack limits actions blocks to 25 elements, and max 5 actions blocks per message. */
const MAX_BUTTONS_PER_BLOCK = 25;

async function postProjectPicker(
  client: WebClient,
  channel: string,
  threadTs: string,
  prompt: string,
  projects: Project[],
  pendingCwd: Map<string, PendingCwd>,
  headerText: string,
  files: SlackFile[] = [],
): Promise<void> {
  // Build buttons — projects + home fallback
  const allChoices = [
    ...projects.map((p) => ({ label: p.label, value: p.path })),
    { label: "🏠 Home", value: homedir() },
  ];

  // Split into actions blocks of up to 25 buttons each
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: { type: "mrkdwn", text: headerText },
    },
  ];

  for (let i = 0; i < allChoices.length; i += MAX_BUTTONS_PER_BLOCK) {
    const chunk = allChoices.slice(i, i + MAX_BUTTONS_PER_BLOCK);
    blocks.push({
      type: "actions",
      elements: chunk.map((choice, j) => ({
        type: "button",
        text: { type: "plain_text", text: choice.label },
        action_id: `select_cwd_${i + j}`,
        value: choice.value,
      })),
    });
  }

  const result = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: headerText,
    blocks: blocks as any,
  });

  if (result.ts) {
    pendingCwd.set(result.ts, { threadTs, channelId: channel, prompt, files });
  }
}

export interface SlackApp {
  app: App;
  sessionManager: BotSessionManager;
  knownProjects: string[];
  pendingCwd: Map<string, PendingCwd>;
  attachServer: AttachServer | null;
}

export function createApp(config: Config, attachServer?: AttachServer): SlackApp {
  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
  });

  const sessionManager = new BotSessionManager(config, app.client);
  // loadProjects re-reads ~/.pi-slack-bot/projects.json on every call,
  // so edits take effect without restart.
  let projects = loadProjects(config.workspaceDirs);
  let knownProjects = projectPaths(projects);
  const pendingCwd = new Map<string, PendingCwd>();

  /** Refresh project list from disk. Called on every message so config changes take effect immediately. */
  function refreshProjects(): void {
    projects = loadProjects(config.workspaceDirs);
    knownProjects = projectPaths(projects);
  }

  app.event("message", async ({ event, client }) => {
    if (!("user" in event) || !("text" in event)) return;
    // Allow file_share subtype through — user uploaded a file.
    // bot_message is filtered out by the subtype check (it's not "file_share").
    if (event.subtype && event.subtype !== "file_share") return;
    if (event.user !== config.slackUserId) return;

    // Refresh project list so config changes take effect immediately
    refreshProjects();

    const channel = event.channel;
    const threadTs = ("thread_ts" in event ? event.thread_ts : undefined) ?? event.ts;
    const text = event.text ?? "";

    // Extract any files attached to this message
    const slackFiles: SlackFile[] = [];
    if ("files" in event && Array.isArray((event as any).files)) {
      for (const f of (event as any).files) {
        slackFiles.push({
          id: f.id,
          name: f.name ?? "unknown",
          mimetype: f.mimetype,
          size: f.size ?? 0,
          urlPrivateDownload: f.url_private_download,
          urlPrivate: f.url_private,
        });
      }
    }

    // Command detection — handle !commands before cwd parsing
    const cmd = parseCommand(text);
    if (cmd) {
      const session = sessionManager.get(threadTs);
      await dispatchCommand(cmd.name, cmd.args, {
        channel,
        threadTs,
        client,
        sessionManager,
        session,
      });
      return;
    }

    // Attached sessions — forward messages to the pi extension via WebSocket
    if (attachServer?.hasSession(threadTs)) {
      // Download any shared files into the attached session's cwd
      const attachCwd = attachServer.getSessionCwd(threadTs);
      if (slackFiles.length > 0 && attachCwd) {
        const prompt = await enrichPromptWithFiles(slackFiles, text, attachCwd, config.slackBotToken);
        attachServer.sendUserMessage(threadTs, prompt);
      } else {
        attachServer.sendUserMessage(threadTs, text);
      }
      return;
    }

    // Check for pending Ralph preset prompt follow-up
    const ralphFollow = tryConsumeRalphPrompt(threadTs, text);
    if (ralphFollow) {
      ralphFollow.session.enqueue(() => ralphFollow.session.prompt(ralphFollow.command));
      return;
    }

    // Thread replies skip cwd parsing — session already exists
    const isThreadReply = "thread_ts" in event && event.thread_ts !== undefined;
    if (isThreadReply) {
      const existing = sessionManager.get(threadTs);
      if (existing) {
        const prompt = await enrichPromptWithFiles(slackFiles, text, existing.cwd, config.slackBotToken);
        existing.enqueue(() => existing.prompt(prompt));
        return;
      }
      // Thread reply but no session — fall through to create with homedir
    }

    const parsed = parseMessage(text, knownProjects);

    try {
      if (parsed.cwd) {
        // Exact cwd resolved
        const session = await sessionManager.getOrCreate({
          threadTs,
          channelId: channel,
          cwd: parsed.cwd,
        });
        const prompt = await enrichPromptWithFiles(slackFiles, parsed.prompt, session.cwd, config.slackBotToken);
        session.enqueue(() => session.prompt(prompt));
      } else if (parsed.candidates.length > 0) {
        // Fuzzy matches — show matching projects as buttons
        const matched = projects.filter((p) => parsed.candidates.includes(p.path));
        await postProjectPicker(client, channel, threadTs, parsed.prompt, matched, pendingCwd,
          `Multiple projects match \`${parsed.cwdToken}\`. Pick one:`, slackFiles);
      } else {
        // No cwd token or no match — show all projects as a picker
        await postProjectPicker(client, channel, threadTs, text, projects, pendingCwd,
          "📂 Pick a project directory:", slackFiles);
      }
    } catch (err) {
      if (err instanceof SessionLimitError) {
        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: "⚠️ Too many active sessions. Try again later.",
        });
        return;
      }
      throw err;
    }
  });

  app.action(/^select_cwd_/, async ({ action, body, ack, client }) => {
    await ack();

    if (action.type !== "button" || !("value" in action)) return;
    if (body.type !== "block_actions") return;
    const messageTs = body.message?.ts;
    if (!messageTs) return;

    const pending = pendingCwd.get(messageTs);
    if (!pending) return;
    pendingCwd.delete(messageTs);

    const selectedCwd = action.value!;

    // Update button message to show selection
    await client.chat.update({
      channel: pending.channelId,
      ts: messageTs,
      text: `📂 Using \`${selectedCwd}\``,
      blocks: [],
    });

    try {
      const session = await sessionManager.getOrCreate({
        threadTs: pending.threadTs,
        channelId: pending.channelId,
        cwd: selectedCwd,
      });
      const prompt = await enrichPromptWithFiles(pending.files, pending.prompt, session.cwd, config.slackBotToken);
      session.enqueue(() => session.prompt(prompt));
    } catch (err) {
      if (err instanceof SessionLimitError) {
        await client.chat.postMessage({
          channel: pending.channelId,
          thread_ts: pending.threadTs,
          text: "⚠️ Too many active sessions. Try again later.",
        });
      }
    }
  });

  /* ── File picker action handlers ─────────────────────────────────── */

  // File selected
  app.action(/^file_pick_select_/, async ({ action, body, ack }) => {
    await ack();
    if (action.type !== "button" || !("value" in action)) return;
    if (body.type !== "block_actions") return;
    const messageTs = body.message?.ts;
    if (!messageTs) return;
    await handleFileSelect(messageTs, action.value!);
  });

  // Navigate into a directory
  app.action(/^file_pick_nav_/, async ({ action, body, ack }) => {
    await ack();
    if (action.type !== "button" || !("value" in action)) return;
    if (body.type !== "block_actions") return;
    const messageTs = body.message?.ts;
    if (!messageTs) return;
    await handleFileNav(messageTs, action.value!);
  });

  // Navigate to parent directory
  app.action("file_pick_nav_parent", async ({ action, body, ack }) => {
    await ack();
    if (action.type !== "button" || !("value" in action)) return;
    if (body.type !== "block_actions") return;
    const messageTs = body.message?.ts;
    if (!messageTs) return;
    await handleFileNav(messageTs, action.value!);
  });

  // Cancel file picker
  app.action("file_pick_cancel", async ({ action, body, ack }) => {
    await ack();
    if (body.type !== "block_actions") return;
    const messageTs = body.message?.ts;
    if (!messageTs) return;
    await handleFilePickCancel(messageTs);
  });

  /* ── Ralph preset picker action handlers ─────────────────────────── */

  app.action(/^ralph_preset_/, async ({ action, body, ack }) => {
    await ack();
    if (action.type !== "button" || !("value" in action)) return;
    if (body.type !== "block_actions") return;
    const messageTs = body.message?.ts;
    if (!messageTs) return;
    await handleRalphPresetSelect(messageTs, action.value!);
  });

  /* ── Prompt template picker action handlers ──────────────────────── */

  app.action(/^prompt_pick_/, async ({ action, body, ack }) => {
    await ack();
    if (action.type !== "button" || !("value" in action)) return;
    if (body.type !== "block_actions") return;
    const messageTs = body.message?.ts;
    if (!messageTs) return;
    await handlePromptSelect(messageTs, action.value!);
  });

  /* ── Session resume picker action handlers ──────────────────────── */

  app.action(/^resume_project_/, async ({ action, body, ack }) => {
    await ack();
    if (action.type !== "button" || !("value" in action)) return;
    if (body.type !== "block_actions") return;
    const messageTs = body.message?.ts;
    if (!messageTs) return;
    await handleResumeProjectSelect(messageTs, action.value!);
  });

  app.action(/^resume_session_/, async ({ action, body, ack }) => {
    await ack();
    if (action.type !== "button" || !("value" in action)) return;
    if (body.type !== "block_actions") return;
    const messageTs = body.message?.ts;
    if (!messageTs) return;
    await handleResumeSessionSelect(messageTs, action.value!);
  });

  return {
    app,
    sessionManager,
    get knownProjects() { return knownProjects; },
    set knownProjects(v: string[]) { knownProjects = v; },
    pendingCwd,
    attachServer: attachServer ?? null,
  };
}
