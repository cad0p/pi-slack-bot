import { WebSocketServer, WebSocket } from "ws";
import type { WebClient } from "@slack/web-api";
import type { Config } from "./config.js";
import { StreamingUpdater, type StreamingState } from "./streaming-updater.js";

export interface AttachSession {
  ws: WebSocket;
  threadTs: string;
  channelId: string;
  cwd: string;
  streamingState: StreamingState | null;
  connectedAt: Date;
}

interface RegisterMessage {
  type: "register";
  sessionId: string;
  cwd: string;
}

interface TextDeltaMessage {
  type: "text_delta";
  delta: string;
}

interface ToolStartMessage {
  type: "tool_start";
  toolName: string;
  args: unknown;
}

interface ToolEndMessage {
  type: "tool_end";
  toolName: string;
  isError: boolean;
}

interface RetryStartMessage {
  type: "retry_start";
  attempt: number;
}

type IncomingMessage =
  | RegisterMessage
  | TextDeltaMessage
  | ToolStartMessage
  | ToolEndMessage
  | RetryStartMessage
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "detach" };

export class AttachServer {
  private _wss: WebSocketServer | null = null;
  private _sessions = new Map<string, AttachSession>();
  private _updater: StreamingUpdater;
  private _client: WebClient;
  private _config: Config;

  constructor(config: Config, client: WebClient) {
    this._config = config;
    this._client = client;
    this._updater = new StreamingUpdater(client, config.streamThrottleMs, config.slackMsgLimit);
  }

  start(): void {
    this._wss = new WebSocketServer({ port: this._config.attachPort });

    this._wss.on("connection", (ws) => {
      let registered = false;
      let sessionThreadTs: string | null = null;

      ws.on("message", (raw) => {
        let msg: IncomingMessage;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        if (!registered && msg.type !== "register") return;

        void this._handleMessage(ws, msg).then((threadTs) => {
          if (threadTs) {
            registered = true;
            sessionThreadTs = threadTs;
          }
        }).catch((err) => {
          console.error("[AttachServer] message handler error:", err);
        });
      });

      ws.on("close", () => {
        if (sessionThreadTs) {
          void this._handleDisconnect(sessionThreadTs);
        }
      });
    });
  }

  private async _handleMessage(ws: WebSocket, msg: IncomingMessage): Promise<string | null> {
    switch (msg.type) {
      case "register":
        return this._handleRegister(ws, msg);

      case "agent_start": {
        const session = this._findByWs(ws);
        if (!session) return null;
        session.streamingState = await this._updater.begin(session.channelId, session.threadTs);
        return null;
      }

      case "text_delta": {
        const session = this._findByWs(ws);
        if (!session?.streamingState) return null;
        this._updater.appendText(session.streamingState, msg.delta);
        return null;
      }

      case "tool_start": {
        const session = this._findByWs(ws);
        if (!session?.streamingState) return null;
        this._updater.appendToolStart(session.streamingState, msg.toolName, msg.args);
        return null;
      }

      case "tool_end": {
        const session = this._findByWs(ws);
        if (!session?.streamingState) return null;
        this._updater.appendToolEnd(session.streamingState, msg.toolName, msg.isError);
        return null;
      }

      case "agent_end": {
        const session = this._findByWs(ws);
        if (!session?.streamingState) return null;
        await this._updater.finalize(session.streamingState);
        session.streamingState = null;
        return null;
      }

      case "retry_start": {
        const session = this._findByWs(ws);
        if (!session?.streamingState) return null;
        this._updater.appendRetry(session.streamingState, msg.attempt);
        return null;
      }

      case "detach": {
        const session = this._findByWs(ws);
        if (!session) return null;
        await this._handleDisconnect(session.threadTs);
        ws.close();
        return null;
      }

      default:
        return null;
    }
  }

  private async _handleRegister(ws: WebSocket, msg: RegisterMessage): Promise<string> {
    // Open DM channel with the configured user
    const dmRes = await this._client.conversations.open({
      users: this._config.slackUserId,
    });
    const channelId = dmRes.channel!.id!;

    // Post thread starter
    const postRes = await this._client.chat.postMessage({
      channel: channelId,
      text: `🔗 Session attached from \`${msg.cwd}\``,
    });
    const threadTs = postRes.ts!;

    const session: AttachSession = {
      ws,
      threadTs,
      channelId,
      cwd: msg.cwd,
      streamingState: null,
      connectedAt: new Date(),
    };
    this._sessions.set(threadTs, session);

    // Send thread info back to the extension
    ws.send(JSON.stringify({
      type: "thread_created",
      threadTs,
      threadUrl: `https://slack.com/archives/${channelId}/p${threadTs.replace(".", "")}`,
    }));

    return threadTs;
  }

  private async _handleDisconnect(threadTs: string): Promise<void> {
    const session = this._sessions.get(threadTs);
    if (!session) return;
    this._sessions.delete(threadTs);

    try {
      await this._client.chat.postMessage({
        channel: session.channelId,
        thread_ts: session.threadTs,
        text: "🔌 Session detached",
      });
    } catch (err) {
      console.error("[AttachServer] detach notice error:", err);
    }
  }

  sendUserMessage(threadTs: string, text: string): void {
    const session = this._sessions.get(threadTs);
    if (!session) return;
    session.ws.send(JSON.stringify({
      type: "user_message",
      text,
      ts: Date.now().toString(),
    }));
  }

  sendCancel(threadTs: string): void {
    const session = this._sessions.get(threadTs);
    if (!session) return;
    session.ws.send(JSON.stringify({ type: "cancel" }));
  }

  hasSession(threadTs: string): boolean {
    return this._sessions.has(threadTs);
  }

  getSessionCwd(threadTs: string): string | undefined {
    return this._sessions.get(threadTs)?.cwd;
  }

  stop(): void {
    for (const session of this._sessions.values()) {
      session.ws.close();
    }
    this._sessions.clear();
    if (this._wss) {
      this._wss.close();
      this._wss = null;
    }
  }

  private _findByWs(ws: WebSocket): AttachSession | null {
    for (const session of this._sessions.values()) {
      if (session.ws === ws) return session;
    }
    return null;
  }
}
