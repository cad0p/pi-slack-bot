import { describe, it, expect } from "vitest";
import { extractSignals } from "./listener-signals.js";

describe("extractSignals", () => {
  it("extracts CR URLs", () => {
    const signals = extractSignals("Check out https://code.amazon.com/reviews/CR-12345678");
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe("cr");
    expect(signals[0].id).toBe("CR-12345678");
    expect(signals[0].url).toBe("https://code.amazon.com/reviews/CR-12345678");
  });

  it("extracts bare CR references", () => {
    const signals = extractSignals("Please review CR-99887766");
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe("cr");
    expect(signals[0].id).toBe("CR-99887766");
  });

  it("deduplicates CR references (URL + bare)", () => {
    const signals = extractSignals(
      "See https://code.amazon.com/reviews/CR-12345678 aka CR-12345678",
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].id).toBe("CR-12345678");
  });

  it("extracts t.corp SIM tickets", () => {
    const signals = extractSignals("Filed t.corp/V123456789 for this issue");
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe("sim");
    expect(signals[0].id).toBe("V123456789");
    expect(signals[0].url).toBe("https://t.corp.amazon.com/V123456789");
  });

  it("extracts issues.amazon.com SIM tickets", () => {
    const signals = extractSignals("See https://issues.amazon.com/issues/ABCD-12345");
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe("sim");
    expect(signals[0].id).toBe("ABCD-12345");
  });

  it("extracts tt/ shorthand SIM tickets", () => {
    const signals = extractSignals("Check tt/V999888777");
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe("sim");
    expect(signals[0].id).toBe("V999888777");
  });

  it("extracts pipeline URLs", () => {
    const signals = extractSignals(
      "Pipeline at https://pipelines.amazon.com/pipelines/my-deploy-pipeline",
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe("pipeline");
    expect(signals[0].id).toBe("my-deploy-pipeline");
  });

  it("extracts wiki URLs", () => {
    const signals = extractSignals("Docs at https://w.amazon.com/bin/view/MyTeam/Runbook");
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe("url");
    expect(signals[0].id).toBe("MyTeam/Runbook");
  });

  it("extracts quip URLs", () => {
    const signals = extractSignals("Design doc: https://quip-amazon.com/abc123def456");
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe("url");
    expect(signals[0].id).toBe("abc123def456");
  });

  it("extracts multiple different signal types", () => {
    const text = [
      "CR-11111111 needs review.",
      "Related to t.corp/V222222222.",
      "Deployed via https://pipelines.amazon.com/pipelines/my-pipe.",
    ].join(" ");
    const signals = extractSignals(text);
    expect(signals).toHaveLength(3);
    const types = signals.map((s) => s.type).sort();
    expect(types).toEqual(["cr", "pipeline", "sim"]);
  });

  it("returns empty for plain text", () => {
    expect(extractSignals("Just a regular message, nothing to see here.")).toHaveLength(0);
  });

  it("returns empty for empty string", () => {
    expect(extractSignals("")).toHaveLength(0);
  });

  it("ignores short CR-like strings (< 5 digits)", () => {
    expect(extractSignals("CR-123 is not a valid CR")).toHaveLength(0);
  });
});
