import { createGoogle } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import type { LanguageModel } from "ai";
import { createOllama } from "ollama-ai-provider-v2";
import type { LlmConfig } from "./types";

/**
 * Maps our provider-agnostic config onto a concrete Vercel AI SDK model.
 * This is the only file that knows about specific providers.
 */
export function resolveModel(config: LlmConfig): LanguageModel {
  switch (config.provider) {
    case "ollama": {
      const ollama = createOllama(config.baseUrl ? { baseURL: `${config.baseUrl}/api` } : {});
      return ollama(config.model);
    }
    case "groq": {
      const groq = createGroq({ apiKey: config.apiKey });
      return groq(config.model);
    }
    case "gemini": {
      const google = createGoogle({ apiKey: config.apiKey });
      return google(config.model);
    }
  }
}
