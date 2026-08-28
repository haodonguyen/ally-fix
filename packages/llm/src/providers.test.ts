import { describe, expect, it } from "vitest";
import { resolveModel } from "./providers";

/**
 * This module is the only place that knows about specific providers. The test is
 * deliberately shallow — it builds a model handle, it does not call one — but it
 * catches the failure that actually happens here: a provider factory renamed or
 * re-exported differently by an SDK upgrade, which would otherwise only surface
 * at runtime in the worker.
 */
describe("resolveModel", () => {
  it("builds a model for every supported provider", () => {
    expect(resolveModel({ provider: "ollama", model: "llama3.1" })).toBeDefined();
    expect(
      resolveModel({ provider: "groq", model: "openai/gpt-oss-20b", apiKey: "k" }),
    ).toBeDefined();
    expect(
      resolveModel({ provider: "gemini", model: "gemini-2.0-flash", apiKey: "k" }),
    ).toBeDefined();
  });

  it("accepts a custom Ollama base URL", () => {
    expect(
      resolveModel({ provider: "ollama", model: "llama3.1", baseUrl: "http://ollama:11434" }),
    ).toBeDefined();
  });

  it("does not require an API key for the local provider", () => {
    expect(() => resolveModel({ provider: "ollama", model: "llama3.1" })).not.toThrow();
  });
});
