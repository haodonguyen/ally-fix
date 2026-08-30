import { llmIssueAnalysisSchema } from "@ally-fix/shared";
import { generateObject } from "ai";
import { createCircuitBreaker, type CircuitBreaker } from "./circuit-breaker";
import {
  LlmAnalysisError,
  LlmError,
  LlmTimeoutError,
  LlmValidationError,
  classifyProviderError,
} from "./errors";
import { analysisSystemPrompt, buildAnalysisPrompt, promptFingerprint } from "./prompt";
import { resolveModel } from "./providers";
import { createTokenBucket, noopThrottle, type Throttle } from "./throttle";
import type { IssueGroupInput, LlmAnalysisResult, LlmClient, LlmConfig } from "./types";
import {
  addUsage,
  defaultPricesFor,
  estimateCostUsd,
  readUsage,
  type TokenPrices,
  type TokenUsage,
} from "./usage";

/** What one provider call produced: the raw object, and what it consumed. */
export interface SingleShotResult {
  output: unknown;
  /** Null when the provider reported no token counts — not zero. */
  usage: TokenUsage | null;
}

/**
 * The single-shot generation primitive: given a system + user prompt, return the
 * model's raw object and its token usage. The real implementation calls the AI
 * SDK; tests inject a fake so the retry/validation logic can be exercised
 * without a provider.
 *
 * Usage rides back with the output rather than through a callback because it is
 * per-attempt: the retry loop has to add up what the failed attempts spent, and
 * a side channel makes that easy to forget.
 *
 * The `signal` is the caller's deadline — implementations must forward it so an
 * abort actually cancels the in-flight request instead of leaking it.
 */
export type SingleShotGenerate = (args: {
  system: string;
  prompt: string;
  signal: AbortSignal;
}) => Promise<SingleShotResult>;

export interface CreateLlmClientOptions {
  /** Extra attempts after the first, on a validation or provider failure. Default 3. */
  maxRetries?: number;
  /** Base backoff between retries in ms; doubles each attempt. Default 800. Set 0 in tests. */
  retryDelayMs?: number;
  /** Upper bound on a single backoff wait, before jitter. Default 20s. */
  maxRetryDelayMs?: number;
  /**
   * Per-million-token rates for costing calls. Defaults to the provider's known
   * rate, which exists only for Ollama (local, genuinely zero). Hosted providers
   * report a null cost until the operator supplies one.
   */
  prices?: TokenPrices;
  /** Deadline for one attempt, in ms. Default 60s. 0 or less disables it. */
  timeoutMs?: number;
  /** Sustained outbound request rate. 0 or less disables throttling. Default 0. */
  requestsPerMinute?: number;
  /** Consecutive provider failures before the circuit opens. 0 disables it. Default 5. */
  circuitBreakerThreshold?: number;
  /** How long the circuit stays open before probing again. Default 30s. */
  circuitBreakerResetMs?: number;
  /**
   * Put the WCAG and axe reference material for the rule into the prompt.
   * Default true. The eval flips it to measure what grounding is worth.
   */
  grounded?: boolean;
  /** Test seams. */
  generate?: SingleShotGenerate;
  throttle?: Throttle;
  circuitBreaker?: CircuitBreaker;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 20_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `operation` under a deadline, aborting the underlying request when it
 * expires. We own the AbortController rather than using `AbortSignal.timeout`
 * so the timeout surfaces as our own typed error regardless of how the provider
 * SDK reports an abort — some throw `AbortError`, some a generic API error.
 */
async function withTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return operation(new AbortController().signal);
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Racing the deadline rather than relying only on the abort keeps the promise
  // honest even if an implementation ignores the signal — a hung socket must not
  // be able to stall the worker forever.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new LlmTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  // If the race below never observes it (the operation threw synchronously) the
  // timer is cleared in `finally`, but attach a sink so a rejection that is
  // already queued cannot escape as an unhandled rejection.
  deadline.catch(() => undefined);

  try {
    // Invoked inside the try so that an implementation which throws *synchronously*
    // still reaches the finally below. Outside it, the timer would leak and the
    // unawaited `deadline` would later reject with no handler — an unhandled
    // rejection, which terminates the process under Node's default.
    const running = operation(controller.signal);
    // The loser of the race still settles; swallow a late rejection so it doesn't
    // surface as an unhandled rejection. The race itself still sees the original.
    running.catch(() => undefined);
    return await Promise.race([running, deadline]);
  } catch (error) {
    // The callee honored the abort and threw its own error (AbortError, or a
    // provider-specific wrapper) — report it as our timeout, not a provider fault.
    if (controller.signal.aborted && !(error instanceof LlmTimeoutError)) {
      throw new LlmTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Exponential backoff with full jitter: wait a random point in [0, backoff)
 * rather than the backoff itself. Without jitter, concurrent workers that fail
 * together retry together — they stay in lockstep and re-create the burst that
 * rate-limited them in the first place.
 */
export function backoffDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number,
): number {
  if (baseMs <= 0) return 0;
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

/**
 * Best-effort recovery of a response that ignored the structured-output contract.
 *
 * Hosted providers honour JSON mode, but a small local model often answers with
 * the object wrapped in a markdown fence, as a plain string. Unwrapping once
 * before validating turns a guaranteed retry into a hit; if it still doesn't
 * parse we hand back the original so the error message shows what really arrived.
 */
export function coerceRawOutput(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const unfenced = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    return raw;
  }
}

/**
 * Creates a provider-agnostic LLM client with the full outbound failure policy:
 * a per-attempt deadline, rate limiting, retry with jittered backoff, and a
 * circuit breaker. Structured output is validated against `llmIssueAnalysisSchema`
 * (from @ally-fix/shared); a parse failure triggers a retry but never opens the
 * circuit, because a badly-formatted answer is not an unhealthy provider.
 */
export function createLlmClient(
  config: LlmConfig,
  options: CreateLlmClientOptions = {},
): LlmClient {
  const maxRetries = options.maxRetries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 800;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const grounded = options.grounded ?? true;
  const system = analysisSystemPrompt(grounded);
  const prices = options.prices ?? config.prices ?? defaultPricesFor(config.provider);

  const throttle =
    options.throttle ??
    (options.requestsPerMinute
      ? createTokenBucket({ requestsPerMinute: options.requestsPerMinute })
      : noopThrottle);

  // createCircuitBreaker already degrades to a no-op at a threshold of 0.
  const breaker =
    options.circuitBreaker ??
    createCircuitBreaker({
      failureThreshold: options.circuitBreakerThreshold ?? 5,
      resetTimeoutMs: options.circuitBreakerResetMs ?? 30_000,
    });

  const generate: SingleShotGenerate =
    options.generate ??
    (async ({ system, prompt, signal }) => {
      const { object, usage } = await generateObject({
        model: resolveModel(config),
        schema: llmIssueAnalysisSchema,
        system,
        prompt,
        abortSignal: signal,
        // We own the retry loop below, so don't let the SDK stack its own on top.
        maxRetries: 0,
      });
      return { output: object, usage: readUsage(usage) };
    });

  /**
   * One attempt: wait for rate-limit budget, call the provider, validate the shape.
   *
   * `spend` is called with whatever the provider reported *before* validation can
   * reject the answer. A response that fails the schema was still generated and
   * still billed, so its tokens have to be counted even though its content is
   * thrown away.
   */
  async function attempt(prompt: string, spend: (usage: TokenUsage | null) => void) {
    await throttle.acquire();

    const result = await withTimeout(timeoutMs, (signal) =>
      generate({ system, prompt, signal }),
    ).catch((error: unknown) => {
      // Anything thrown by the provider becomes a typed provider error, so the
      // breaker and the retry loop can classify it without duck-typing.
      if (error instanceof LlmTimeoutError) throw error;
      throw classifyProviderError(error);
    });

    spend(result.usage);

    const parsed = llmIssueAnalysisSchema.safeParse(coerceRawOutput(result.output));
    if (!parsed.success) throw new LlmValidationError(parsed.error.message, parsed.error);
    return parsed.data;
  }

  return {
    promptFingerprint: promptFingerprint(grounded),

    async analyzeIssueGroup(input: IssueGroupInput): Promise<LlmAnalysisResult> {
      const prompt = buildAnalysisPrompt(input, { grounded });
      let lastError: unknown;
      let attempts = 0;
      // Accumulated across attempts, so a group that only parsed on the third try
      // reports all three calls. Charging for one would make retries look free.
      let usage: TokenUsage | null = null;
      const spend = (attemptUsage: TokenUsage | null) => {
        usage = addUsage(usage, attemptUsage);
      };

      for (let tries = 0; tries <= maxRetries; tries++) {
        attempts++;
        try {
          // The breaker wraps each attempt rather than the whole loop, so a
          // provider that dies mid-retry short-circuits the remaining attempts.
          const analysis = await breaker.execute(() => attempt(prompt, spend));
          return { analysis, usage, costUsd: estimateCostUsd(usage, prices), attempts };
        } catch (error) {
          lastError = error;
          // Don't waste attempts (and quota) on errors that can't succeed on
          // retry: a 401 for a bad key, a 404 for an unknown model, or an open
          // circuit that is deliberately refusing calls.
          if (error instanceof LlmError && !error.retryable) break;
          if (tries < maxRetries) {
            const delay = backoffDelay(tries, retryDelayMs, maxRetryDelayMs, random);
            if (delay > 0) await sleep(delay);
          }
        }
      }

      throw new LlmAnalysisError(attempts, lastError, usage);
    },
  };
}
