import fs from "fs/promises";
import type { WebClient } from "@slack/web-api";
import type { Config, ThinkingLevel } from "./config.js";
import { ThreadSession, type ThreadSessionCreateParams } from "./thread-session.js";

export class SessionLimitError extends Error {
  constructor() {
    super("Too many active sessions");
    this.name = "SessionLimitError";
  }
}

export interface ThreadSessionInfo {
  threadTs: string;
  channelId: string;
  cwd: string;
  messageCount: number;
  model: string;
  thinkingLevel: ThinkingLevel;
  lastActivity: Date;
  isStreaming: boolean;
}

export interface GetOrCreateParams {
  threadTs: string;
  channelId: string;
  cwd: string;
  /** If set, resume from this existing session file instead of creating a new one. */
  resumeSessionPath?: string;
}

type SessionFactory = (params: ThreadSessionCreateParams) => Promise<ThreadSession>;

export class BotSessionManager {
  private _sessions = new Map<string, ThreadSession>();
  private _reaper: ReturnType<typeof setInterval>;

  constructor(
    private _config: Config,
    private _client: WebClient,
    private _factory: SessionFactory = ThreadSession.create,
  ) {
    this._reaper = setInterval(() => void this._reap(), 60_000);
  }

  get(threadTs: string): ThreadSession | undefined {
    return this._sessions.get(threadTs);
  }

  async getOrCreate(params: GetOrCreateParams): Promise<ThreadSession> {
    const existing = this._sessions.get(params.threadTs);
    if (existing) return existing;

    if (this._sessions.size >= this._config.maxSessions) {
      throw new SessionLimitError();
    }

    await fs.mkdir(this._config.sessionDir, { recursive: true });

    const session = await this._factory({
      ...params,
      config: this._config,
      client: this._client,
      sessionDir: this._config.sessionDir,
    });

    this._sessions.set(params.threadTs, session);
    return session;
  }

  async dispose(threadTs: string): Promise<void> {
    const session = this._sessions.get(threadTs);
    if (session) {
      this._sessions.delete(threadTs);
      await session.dispose();
    }
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this._sessions.keys()].map((ts) => this.dispose(ts)));
  }

  list(): ThreadSessionInfo[] {
    return [...this._sessions.values()].map((s) => ({
      threadTs: s.threadTs,
      channelId: s.channelId,
      cwd: s.cwd,
      messageCount: s.messageCount,
      model: s.model?.id ?? "unknown",
      thinkingLevel: s.thinkingLevel,
      lastActivity: s.lastActivity,
      isStreaming: s.isStreaming,
    }));
  }

  count(): number {
    return this._sessions.size;
  }

  get sessionDir(): string {
    return this._config.sessionDir;
  }

  stopReaper(): void {
    clearInterval(this._reaper);
  }

  private async _reap(): Promise<void> {
    const now = Date.now();
    const timeout = this._config.sessionIdleTimeoutSecs * 1000;
    for (const [ts, session] of this._sessions) {
      if (now - session.lastActivity.getTime() > timeout) {
        await this.dispose(ts);
      }
    }
  }
}
