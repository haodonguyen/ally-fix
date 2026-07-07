import { describe, expect, it, vi } from "vitest";
import { createLlmClient } from "./client";
import type { LlmConfig } from "./types";

const config: LlmConfig = { provider: "ollama", model: "test-model" };

const validAnalysis = {
  explanation: "Images need alternative text.",
  affectedUsers: ["screen reader users"],
  fixCode: '<img src="a.png" alt="A cat">',
  priority: "high",
};

describe("createLlmClient.analyzeIssueGroup", () => {
  it("returns a schema-validated analysis on the first try", async () => {
    const generate = vi.fn().mockResolvedValue(validAnalysis);
    const client = createLlmClient(config, { generate });

    const result = await client.analyzeIssueGroup({ ruleId: "image-alt", htmlSnippets: ["<img>"] });

    expect(result.priority).toBe("high");
    expect(result.affectedUsers).toEqual(["screen reader users"]);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("retries when the model returns something that fails the schema", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ not: "valid" })
      .mockResolvedValueOnce(validAnalysis);
    const client = createLlmClient(config, { generate, maxRetries: 2 });

    const result = await client.analyzeIssueGroup({ ruleId: "image-alt", htmlSnippets: ["<img>"] });

    expect(result.explanation).toContain("alternative text");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting retries", async () => {
    const generate = vi.fn().mockResolvedValue({ still: "invalid" });
    const client = createLlmClient(config, { generate, maxRetries: 1 });

    await expect(
      client.analyzeIssueGroup({ ruleId: "image-alt", htmlSnippets: ["<img>"] }),
    ).rejects.toThrow(/failed after 2 attempt/);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("does not retry an error the provider marks non-retryable", async () => {
    const authError = Object.assign(new Error("Unauthorized"), { isRetryable: false });
    const generate = vi.fn().mockRejectedValue(authError);
    const client = createLlmClient(config, { generate, maxRetries: 3 });

    await expect(
      client.analyzeIssueGroup({ ruleId: "image-alt", htmlSnippets: ["<img>"] }),
    ).rejects.toThrow(/failed after/);
    expect(generate).toHaveBeenCalledOnce();
  });
});
