import { config as loadDotenv } from "dotenv";
loadDotenv();

import { loadConfig } from "./config.js";
import { createApp } from "./slack.js";
import { AttachServer } from "./attach-server.js";

const config = loadConfig();

console.log("pi-slack-bot starting...");
console.log({
  slackBotToken: config.slackBotToken.slice(0, 10) + "...",
  slackAppToken: config.slackAppToken.slice(0, 10) + "...",
  slackUserId: config.slackUserId,
  provider: config.provider,
  model: config.model,
  thinkingLevel: config.thinkingLevel,
  maxSessions: config.maxSessions,
  sessionIdleTimeoutSecs: config.sessionIdleTimeoutSecs,
  sessionDir: config.sessionDir,
  streamThrottleMs: config.streamThrottleMs,
  slackMsgLimit: config.slackMsgLimit,
  workspaceDirs: config.workspaceDirs,
  attachPort: config.attachPort,
});

const slackApp = createApp(config);

const attachServer = new AttachServer(config, slackApp.app.client);
attachServer.start();
console.log(`Attach server listening on port ${config.attachPort}`);

await slackApp.app.start();
console.log(`Bot running (${slackApp.knownProjects.length} projects discovered)`);

process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  attachServer.stop();
  await slackApp.sessionManager.disposeAll();
  await slackApp.app.stop();
  process.exit(0);
});
