import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { isRalphNotification, isRalphEndNotification } from "./ralph-notifications.js";

describe("isRalphNotification", () => {
  const positives = [
    // Loop lifecycle
    "Ralph loop [1/100]: 📋 Planner → ⚙️ Builder (event: tasks.ready)",
    "Ralph loop ended: Task complete ✓ (4 iterations, 655s)",
    "ralph loop started",
    "Loop paused",
    "Loop resumed",
    "Loop auto-resumed after idle timeout",
    "Loop ended: maximum iterations reached",
    "Loop is not paused",
    "Loop is already running",
    // Status/info
    "Available presets: feature, refactor, review",
    "Preset: feature (plan→build→review→commit)",
    "No active loop",
    "No loop state",
    "No iteration history",
    "No past loops",
    "No presets found",
    // Control
    "Steering queued for next iteration",
    "Unknown preset: foobar",
    "Preset 'debug' has no hats defined",
  ];

  for (const msg of positives) {
    it(`detects: "${msg.slice(0, 60)}${msg.length > 60 ? "..." : ""}"`, () => {
      assert.ok(isRalphNotification(msg), `Should detect: ${msg}`);
    });
  }

  const negatives = [
    "Hello, how are you?",
    "The loop in the code is infinite",
    "This is a regular message",
    "Extension loaded successfully",
    "",
  ];

  for (const msg of negatives) {
    it(`ignores: "${msg || "(empty)"}"`, () => {
      assert.ok(!isRalphNotification(msg), `Should not detect: ${msg}`);
    });
  }
});

describe("isRalphEndNotification", () => {
  const endMessages = [
    "Ralph loop ended: Task complete ✓ (4 iterations, 655s)",
    "Loop ended: maximum iterations reached",
    "Task complete",
    "Loop complete",
  ];

  for (const msg of endMessages) {
    it(`detects end: "${msg.slice(0, 60)}"`, () => {
      assert.ok(isRalphEndNotification(msg), `Should detect end: ${msg}`);
    });
  }

  const nonEndMessages = [
    "Ralph loop [1/100]: 📋 Planner → ⚙️ Builder",
    "Loop paused",
    "Steering queued",
    "Available presets: feature",
  ];

  for (const msg of nonEndMessages) {
    it(`ignores non-end: "${msg.slice(0, 60)}"`, () => {
      assert.ok(!isRalphEndNotification(msg), `Should not detect end: ${msg}`);
    });
  }
});
