import { readFileSync } from "node:fs";
import { z } from "zod";
import type { LlmConfig, LlmProviderName, TokenPrices } from "@ally-fix/llm";

/**
 * Configuration for the model comparison.
 *
 * A file rather than environment variables, for two reasons. Per-model prices
 * are the point of the exercise — a single `LLM_PRICE_*` pair cannot express
 * three models at three rates — and a comparison is worth keeping: the file
 * records exactly which models, at which prices, produced a given table.
 *
 * It never contains a key. An entry names the *environment variable* the key
 * lives in, and a literal `apiKey` is rejected rather than ignored, so anyone
 * who tries is told why instead of quietly shipping a secret into a file that
 * looks committable.
 */

/** The provider's usual key variable, so most entries need not say. */
const DEFAULT_KEY_ENV: Record<LlmProviderName, string | null> = {
  ollama: null, // Local: no key at all.
  groq: "GROQ_API_KEY",
  gemini: "GOOGLE_GENERATIVE_AI_API_KEY",
};

const pricesSchema = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
});

const modelEntrySchema = z
  // Strict: an unrecognised key is a typo, and a silently dropped "prices" or
  // "apiKeyEnv" would produce a table that is wrong in a way nothing flags.
  .strictObject({
    /** Shown in the report. Defaults to "provider/model". */
    label: z.string().min(1).optional(),
    provider: z.enum(["ollama", "groq", "gemini"]),
    model: z.string().min(1),
    /** Ollama only. */
    baseUrl: z.string().url().optional(),
    /** Name of the env var holding the key — never the key itself. */
    apiKeyEnv: z.string().min(1).optional(),
    /**
     * US dollars per million tokens. Omitted means this row's cost is reported
     * as null: an unpriced model must not undercut a priced one by looking free.
     */
    prices: pricesSchema.optional(),
  });

export const modelComparisonSchema = z.object({
  /** Repeats per arm. The model is not deterministic; one run is an anecdote. */
  repeats: z.number().int().positive().max(20).default(1),
  models: z.array(modelEntrySchema).min(2, "a comparison needs at least two models"),
});

export type ModelEntry = z.infer<typeof modelEntrySchema>;
export type ModelComparisonConfig = z.infer<typeof modelComparisonSchema>;

/** One arm of the comparison, ready to build a client from. */
export interface ModelArm {
  label: string;
  config: LlmConfig;
  prices: TokenPrices | null;
}

export function parseModelComparison(raw: unknown): ModelComparisonConfig {
  // Checked against the raw input, before the schema strips it. A literal key in
  // a config file is a leak waiting for someone to `git add` it, and the person
  // who tried deserves to be told why rather than see "unrecognised key".
  rejectInlineKeys(raw);

  const parsed = modelComparisonSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid model comparison config:\n${z.prettifyError(parsed.error)}`);
  }

  const labels = parsed.data.models.map(labelFor);
  const duplicate = labels.find((label, index) => labels.indexOf(label) !== index);
  // Two rows with the same label would silently collapse in the report, which
  // is the one place the reader trusts each line to be a different model.
  if (duplicate) throw new Error(`Duplicate label in model comparison config: ${duplicate}`);

  return parsed.data;
}

function rejectInlineKeys(raw: unknown): void {
  const models = (raw as { models?: unknown })?.models;
  if (!Array.isArray(models)) return;
  for (const entry of models) {
    if (entry && typeof entry === "object" && "apiKey" in entry) {
      throw new Error(
        "Model comparison config contains an inline apiKey. Put the key in an " +
          "environment variable and name that variable with apiKeyEnv instead — " +
          "this file is meant to be safe to read, share, and diff.",
      );
    }
  }
}

export function labelFor(entry: ModelEntry): string {
  return entry.label ?? `${entry.provider}/${entry.model}`;
}

/**
 * Turns one entry into a runnable arm, reading the key from the environment.
 *
 * Throws when a hosted provider's key variable is empty. Running the comparison
 * anyway would score that model at zero and rank it last for a configuration
 * mistake — a wrong answer dressed as a measurement.
 */
export function toArm(entry: ModelEntry, env: NodeJS.ProcessEnv = process.env): ModelArm {
  const keyEnv = entry.apiKeyEnv ?? DEFAULT_KEY_ENV[entry.provider];
  const apiKey = keyEnv ? env[keyEnv]?.trim() : undefined;

  if (keyEnv && !apiKey) {
    throw new Error(
      `${labelFor(entry)} needs an API key: set ${keyEnv} (or point apiKeyEnv at the variable that holds it).`,
    );
  }

  return {
    label: labelFor(entry),
    config: {
      provider: entry.provider,
      model: entry.model,
      ...(apiKey ? { apiKey } : {}),
      ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
      ...(entry.prices ? { prices: entry.prices } : {}),
    },
    prices: entry.prices ?? null,
  };
}

/** Reads and validates the config file. */
export function loadModelComparison(path: string): ModelComparisonConfig {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `No model comparison config at ${path}. Copy eval/models.example.json to eval/models.json and edit it.`,
      { cause: error },
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : error}`,
      {
        cause: error,
      },
    );
  }
  return parseModelComparison(raw);
}
