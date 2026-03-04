import path from "path";
import { mkdirSync } from "fs";
import { createAgentSession, createCodingTools, DefaultResourceLoader, SessionManager as PiSessionManager } from "@mariozechner/pi-coding-agent";
import type { AgentSession, AgentSessionEvent, AgentSessionEventListener, PromptTemplate } from "@mariozechner/pi-coding-agent";
import type { WebClient } from "@slack/web-api";
import type { Config, ThinkingLevel } from "./config.js";
import { StreamingUpdater } from "./streaming-updater.js";
import { createFilePickerTool, type FilePickerContext } from "./file-picker.js";
import { createShareFileTool, type ShareFileContext } from "./file-sharing.js";
import { encodeCwd } from "./session-path.js";

export interface ThreadSessionCreateParams {
  threadTs: string;
  channelId: string;
  cwd: string;
  config: Config;
  client: WebClient;
  sessionDir: string;
  /** If set, resume from this existing session file instead of creating a new one. */
  resumeSessionPath?: string;
}

export class ThreadSession {
  readonly threadTs: string;
  readonly channelId: string;
  cwd: string;
  lastActivity: Date;

  private _agentSession: AgentSession;
  private _resourceLoader: DefaultResourceLoader;
  private _client: WebClient;
  private _updater: StreamingUpdater;
  private _tasks: Array<() => Promise<void>> = [];
  private _processing = false;

  constructor(
    threadTs: string,
    channelId: string,
    cwd: string,
    client: WebClient,
    agentSession: AgentSession,
    resourceLoader: DefaultResourceLoader,
    updater: StreamingUpdater,
  ) {
    this.threadTs = threadTs;
    this.channelId = channelId;
    this.cwd = cwd;
    this._client = client;
    this._agentSession = agentSession;
    this._resourceLoader = resourceLoader;
    this._updater = updater;
    this.lastActivity = new Date();
  }

  static async create(params: ThreadSessionCreateParams): Promise<ThreadSession> {
    // Store sessions in pi's native directory structure so `pi /resume` finds them.
    // Encodes cwd the same way pi does: ~/.pi/agent/sessions/--<encoded-cwd>--/
    const cwdEncoded = encodeCwd(params.cwd);
    const nativeSessionDir = path.join(params.sessionDir, cwdEncoded);
    mkdirSync(nativeSessionDir, { recursive: true });

    // If resuming, use the existing session file; otherwise create a new one.
    const sessionFilePath = params.resumeSessionPath
      ?? path.join(nativeSessionDir, `${params.threadTs}.jsonl`);
    const piSessionManager = PiSessionManager.open(sessionFilePath, nativeSessionDir);

    // DefaultResourceLoader auto-discovers extensions and prompts from ~/.pi/agent/
    const resourceLoader = new DefaultResourceLoader({ cwd: params.cwd });
    await resourceLoader.reload();

    // File picker tool needs Slack context; create a getter that returns
    // the current channel/thread/client (stable for the lifetime of this session).
    const filePickerContext: FilePickerContext = {
      client: params.client,
      channelId: params.channelId,
      threadTs: params.threadTs,
    };
    const filePickerTool = createFilePickerTool(params.cwd, () => filePickerContext);

    // Share file tool — lets the agent upload files to the Slack thread
    const shareFileContext: ShareFileContext = {
      client: params.client,
      channelId: params.channelId,
      threadTs: params.threadTs,
    };
    const shareFileTool = createShareFileTool(params.cwd, () => shareFileContext);

    const { session } = await createAgentSession({
      cwd: params.cwd,
      sessionManager: piSessionManager,
      tools: createCodingTools(params.cwd),
      customTools: [filePickerTool, shareFileTool],
      resourceLoader,
    });

    // Find and set the model from config (provider/model from .env)
    const registry = session.modelRegistry;
    const allModels = registry.getAll();
    const model = allModels.find(
      (m) => m.provider === params.config.provider && m.id === params.config.model,
    ) ?? allModels.find(
      (m) => m.provider === params.config.provider,
    );
    if (model) {
      await session.setModel(model);
      session.setThinkingLevel(params.config.thinkingLevel);
    }

    const updater = new StreamingUpdater(params.client, params.config.streamThrottleMs);

    return new ThreadSession(
      params.threadTs,
      params.channelId,
      params.cwd,
      params.client,
      session,
      resourceLoader,
      updater,
    );
  }

  enqueue(task: () => Promise<void>): void {
    this.lastActivity = new Date();
    this._tasks.push(task);
    if (!this._processing) void this._drain();
  }

  private async _drain(): Promise<void> {
    this._processing = true;
    while (this._tasks.length > 0) {
      const task = this._tasks.shift()!;
      try {
        await task();
      } catch (err) {
        console.error(`[ThreadSession ${this.threadTs}] Task error:`, err);
      }
    }
    this._processing = false;
  }

  async prompt(text: string): Promise<void> {
    // Rewrite !command → /command for pi extension commands & prompt templates.
    // Bot-level commands (help, model, etc.) are intercepted before reaching here,
    // so only pi commands (pdd, ralph, review, etc.) arrive at this point.
    const piText = text.replace(/^!/, "/");

    const state = await this._updater.begin(this.channelId, this.threadTs);

    const unsub = this._agentSession.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        this._updater.appendText(state, event.assistantMessageEvent.delta);
      } else if (event.type === "tool_execution_start") {
        this._updater.appendToolStart(state, event.toolName, event.args);
      } else if (event.type === "tool_execution_end") {
        this._updater.appendToolEnd(state, event.toolName, event.isError);
      }
    });

    try {
      await this._agentSession.prompt(piText);
      await this._updater.finalize(state);
    } catch (err) {
      await this._updater.error(state, err instanceof Error ? err : new Error(String(err)));
    } finally {
      unsub();
    }
  }

  abort(): void {
    void this._agentSession.abort();
  }

  async dispose(): Promise<void> {
    this._agentSession.dispose();
  }

  async newSession(): Promise<void> {
    await this._agentSession.newSession();
  }

  async reload(): Promise<void> {
    // Re-discovers extensions and prompts from disk at the original cwd.
    // Note: project-local .pi/ discovery is bound to the cwd set at session
    // creation. Use !new after !cwd to pick up a different project's .pi/.
    await this._resourceLoader.reload();
  }

  get isStreaming(): boolean {
    return this._agentSession.isStreaming;
  }

  get messageCount(): number {
    return this._agentSession.messages.length;
  }

  get model(): AgentSession["model"] {
    return this._agentSession.model;
  }

  get thinkingLevel(): ThinkingLevel {
    return this._agentSession.thinkingLevel as ThinkingLevel;
  }

  async setModel(modelName: string): Promise<void> {
    const registry = this._agentSession.modelRegistry;
    const all = registry.getAll();
    const match = all.find(
      (m) => m.id === modelName || m.name.toLowerCase() === modelName.toLowerCase(),
    );
    if (!match) {
      throw new Error(`Unknown model: ${modelName}. Available: ${all.map((m) => m.id).join(", ")}`);
    }
    await this._agentSession.setModel(match);
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this._agentSession.setThinkingLevel(level);
  }

  subscribe(handler: AgentSessionEventListener): () => void {
    return this._agentSession.subscribe(handler);
  }

  /** Available file-based prompt templates (e.g. /review, /test, /explain). */
  get promptTemplates(): ReadonlyArray<PromptTemplate> {
    return this._agentSession.promptTemplates;
  }
}
