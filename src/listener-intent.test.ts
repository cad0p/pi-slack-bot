import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist the mock fn so it's available to vi.mock factory
const mockSend = vi.fn();

vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: class {
    send = mockSend;
  },
  InvokeModelCommand: class {
    constructor(public input: unknown) {}
  },
}));

// Dynamic import after mocks are set up
const { classifyIntent } = await import("./listener-intent.js");

function mockLLMResponse(json: Record<string, unknown>) {
  return {
    body: new TextEncoder().encode(JSON.stringify({
      content: [{ text: JSON.stringify(json) }],
    })),
  };
}

describe("classifyIntent", () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it("returns null for very short messages", async () => {
    const result = await classifyIntent("hi");
    expect(result).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("returns null for greeting-only messages", async () => {
    const result = await classifyIntent("hello");
    expect(result).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("classifies a question message", async () => {
    mockSend.mockResolvedValueOnce(mockLLMResponse({
      type: "question",
      confidence: 0.9,
      topic: "Rosie deployment timeline",
      prepHints: ["search vault for Rosie deployment", "check pipeline status"],
      entities: ["Rosie"],
    }));

    const result = await classifyIntent("Hey Sam, when are we deploying Rosie to prod?", {
      channelName: "defect-intelligence-eng",
      userName: "Alice",
    });

    expect(mockSend).toHaveBeenCalledOnce();
    expect(result).not.toBeNull();
    expect(result!.type).toBe("question");
    expect(result!.topic).toBe("Rosie deployment timeline");
    expect(result!.prepHints).toHaveLength(2);
  });

  it("returns null for noise classification", async () => {
    mockSend.mockResolvedValueOnce(mockLLMResponse({
      type: "noise",
      confidence: 0.8,
      topic: "greeting",
      prepHints: [],
      entities: [],
    }));

    const result = await classifyIntent("Good morning everyone!");
    expect(result).toBeNull();
  });

  it("returns null for low-confidence results", async () => {
    mockSend.mockResolvedValueOnce(mockLLMResponse({
      type: "question",
      confidence: 0.3,
      topic: "unclear",
      prepHints: [],
      entities: [],
    }));

    const result = await classifyIntent("Maybe we should look into that sometime");
    expect(result).toBeNull();
  });

  it("handles LLM errors gracefully", async () => {
    mockSend.mockRejectedValueOnce(new Error("Bedrock unavailable"));

    const result = await classifyIntent("Can you check the pipeline status for Nessie?");
    expect(result).toBeNull();
  });

  it("handles malformed LLM response", async () => {
    mockSend.mockResolvedValueOnce({
      body: new TextEncoder().encode(JSON.stringify({
        content: [{ text: "not valid json {{{" }],
      })),
    });

    const result = await classifyIntent("What's the status of the migration?");
    expect(result).toBeNull();
  });

  it("classifies an action request", async () => {
    mockSend.mockResolvedValueOnce(mockLLMResponse({
      type: "action_request",
      confidence: 0.95,
      topic: "Review CR for CSDefect package",
      prepHints: ["check recent CRs for CSDefect"],
      entities: ["CSDefect", "CR"],
    }));

    const result = await classifyIntent("Sam, can you review the latest CR for CSDefect when you get a chance?");
    expect(mockSend).toHaveBeenCalledOnce();
    expect(result).not.toBeNull();
    expect(result!.type).toBe("action_request");
  });

  it("classifies a status ask", async () => {
    mockSend.mockResolvedValueOnce(mockLLMResponse({
      type: "status_ask",
      confidence: 0.85,
      topic: "QoS initiative progress",
      prepHints: ["search vault for QoS", "look up SIM tickets for QoS"],
      entities: ["QoS", "Quality of Service"],
    }));

    const result = await classifyIntent("Where are we on the QoS initiative? Leadership wants an update.");
    expect(mockSend).toHaveBeenCalledOnce();
    expect(result).not.toBeNull();
    expect(result!.type).toBe("status_ask");
    expect(result!.entities).toContain("QoS");
  });
});
