import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { labelFor, loadModelComparison, parseModelComparison, toArm } from "./models";

const valid = {
  repeats: 3,
  models: [
    { provider: "ollama", model: "llama3.1" },
    {
      provider: "groq",
      model: "openai/gpt-oss-20b",
      prices: { inputPerMTok: 0.1, outputPerMTok: 0.5 },
    },
  ],
};

describe("parseModelComparison", () => {
  it("accepts a well-formed config", () => {
    const config = parseModelComparison(valid);
    expect(config.repeats).toBe(3);
    expect(config.models).toHaveLength(2);
  });

  it("defaults repeats to 1 when it is not given", () => {
    expect(parseModelComparison({ models: valid.models }).repeats).toBe(1);
  });

  it("refuses a comparison of fewer than two models", () => {
    expect(() => parseModelComparison({ models: [valid.models[0]] })).toThrow(/at least two/);
  });

  it("refuses an inline API key, and says why", () => {
    // A key in a file that looks committable is a leak waiting to happen. The
    // message has to explain the alternative, not just reject.
    expect(() =>
      parseModelComparison({
        models: [...valid.models, { provider: "groq", model: "m", apiKey: "gsk_secret" }],
      }),
    ).toThrow(/apiKeyEnv/);
  });

  it("rejects an unrecognised key rather than dropping it", () => {
    // A silently ignored "price" (singular) would produce a table that is wrong
    // with nothing to indicate it.
    expect(() =>
      parseModelComparison({
        models: [valid.models[0], { provider: "groq", model: "m", price: 0.1 }],
      }),
    ).toThrow(/Invalid model comparison config/);
  });

  it("rejects an unknown provider", () => {
    expect(() =>
      parseModelComparison({ models: [valid.models[0], { provider: "openai", model: "gpt-4" }] }),
    ).toThrow(/Invalid model comparison config/);
  });

  it("rejects a negative price", () => {
    expect(() =>
      parseModelComparison({
        models: [
          valid.models[0],
          { provider: "groq", model: "m", prices: { inputPerMTok: -1, outputPerMTok: 0.5 } },
        ],
      }),
    ).toThrow(/Invalid model comparison config/);
  });

  it("rejects duplicate labels, which would collapse two rows into one", () => {
    expect(() =>
      parseModelComparison({
        models: [
          { provider: "groq", model: "m", label: "same" },
          { provider: "gemini", model: "n", label: "same" },
        ],
      }),
    ).toThrow(/Duplicate label/);
  });

  it("treats two entries for the same provider and model as duplicates too", () => {
    expect(() =>
      parseModelComparison({
        models: [
          { provider: "groq", model: "openai/gpt-oss-20b" },
          { provider: "groq", model: "openai/gpt-oss-20b" },
        ],
      }),
    ).toThrow(/Duplicate label/);
  });
});

describe("the shipped example", () => {
  it("passes its own validation", () => {
    // An example that fails the moment someone copies it is worse than none.
    const path = fileURLToPath(new URL("./models.example.json", import.meta.url));
    const config = loadModelComparison(path);
    expect(config.models.length).toBeGreaterThanOrEqual(2);
    expect(config.repeats).toBeGreaterThanOrEqual(3);
  });

  it("prices nothing, so a copy reports n/a rather than a made-up cost", () => {
    const path = fileURLToPath(new URL("./models.example.json", import.meta.url));
    for (const entry of loadModelComparison(path).models) {
      expect(entry.prices).toBeUndefined();
    }
  });
});

describe("labelFor", () => {
  it("falls back to provider/model", () => {
    expect(labelFor({ provider: "groq", model: "openai/gpt-oss-20b" })).toBe(
      "groq/openai/gpt-oss-20b",
    );
  });

  it("prefers an explicit label", () => {
    expect(labelFor({ provider: "groq", model: "m", label: "fast one" })).toBe("fast one");
  });
});

describe("toArm", () => {
  it("reads the key from the environment named by the entry", () => {
    const arm = toArm(
      { provider: "groq", model: "m", apiKeyEnv: "MY_KEY" },
      { MY_KEY: "gsk_test" },
    );
    expect(arm.config.apiKey).toBe("gsk_test");
  });

  it("falls back to the provider's usual key variable", () => {
    const arm = toArm({ provider: "gemini", model: "m" }, { GOOGLE_GENERATIVE_AI_API_KEY: "k" });
    expect(arm.config.apiKey).toBe("k");
  });

  it("needs no key at all for a local Ollama", () => {
    const arm = toArm({ provider: "ollama", model: "llama3.1" }, {});
    expect(arm.config.apiKey).toBeUndefined();
  });

  it("fails fast when a hosted key is missing, naming the variable to set", () => {
    // Running anyway would score the model at zero and rank it last for a
    // configuration mistake — a wrong answer dressed up as a measurement.
    expect(() => toArm({ provider: "groq", model: "m" }, {})).toThrow(/GROQ_API_KEY/);
    expect(() => toArm({ provider: "groq", model: "m" }, { GROQ_API_KEY: "  " })).toThrow(
      /GROQ_API_KEY/,
    );
  });

  it("carries prices through, and reports null when there are none", () => {
    const priced = toArm(
      { provider: "groq", model: "m", prices: { inputPerMTok: 0.1, outputPerMTok: 0.5 } },
      { GROQ_API_KEY: "k" },
    );
    expect(priced.prices).toEqual({ inputPerMTok: 0.1, outputPerMTok: 0.5 });
    expect(toArm({ provider: "ollama", model: "m" }, {}).prices).toBeNull();
  });

  it("passes the base url through for Ollama", () => {
    const arm = toArm({ provider: "ollama", model: "m", baseUrl: "http://box:11434" }, {});
    expect(arm.config.baseUrl).toBe("http://box:11434");
  });
});

describe("loadModelComparison", () => {
  const dir = mkdtempSync(join(tmpdir(), "allyfix-models-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const write = (name: string, contents: string) => {
    const path = join(dir, name);
    writeFileSync(path, contents);
    return path;
  };

  it("reads and validates a file", () => {
    const path = write("good.json", JSON.stringify(valid));
    expect(loadModelComparison(path).models).toHaveLength(2);
  });

  it("points at the example when the file is missing", () => {
    // The likeliest reason to hit this is running the script before copying the
    // example, so the error says what to copy rather than just ENOENT.
    expect(() => loadModelComparison(join(dir, "absent.json"))).toThrow(/models.example.json/);
  });

  it("says the file is not JSON rather than throwing a parse error", () => {
    const path = write("bad.json", "{ models: [ }");
    expect(() => loadModelComparison(path)).toThrow(/is not valid JSON/);
  });

  it("still applies every validation rule to a file", () => {
    const path = write("inline-key.json", JSON.stringify({ models: [{ apiKey: "gsk_x" }] }));
    expect(() => loadModelComparison(path)).toThrow(/apiKeyEnv/);
  });
});
