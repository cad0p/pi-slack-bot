import type { KnipConfig } from "knip";

const config: KnipConfig = {
  project: ["src/**/*.ts"],
  ignoreDependencies: [
    // Transitive deps re-exported by @slack/bolt and @mariozechner/pi-coding-agent
    "@slack/web-api",
    "@slack/types",
    "@sinclair/typebox",
    "@mariozechner/pi-ai",
  ],
};

export default config;
