import { llmIssueAnalysisSchema, type LlmIssueAnalysis } from "@ally-fix/shared";
import { generateObject } from "ai";
import { createCircuitBreaker, type CircuitBreaker } from "./circuit-breaker";
import {
  LlmAnalysisError,
  LlmError,
  LlmTimeoutError,
  LlmValidationError,
  classifyProviderError,
} from "./errors";
import { ANALYSIS_SYSTEM_PROMPT, buildAnalysisPrompt } from "./prompt";
import { resolveModel } from "./providers";
import { createTokenBucket, noopThrottle, type Throttle } from "./throttle";
import type { IssueGroupInput, LlmClient, LlmConfig } from "./types";

/**
 * The single-shot generation primitive: given a system + user prompt, return the
 * model's raw object. The real implementation calls the AI SDK; tests inject a
 * fake so the retry/validation logic can be exercised without a provider.
 *
 * The `signal` is the caller's deadline — implementations must forward it so an
 * abort actually cancels the in-flight request instead of leaking it.
 */
export type SingleShotGenerate = (args: {
  system: string;
  prompt: string;
  signal: AbortSignal;
}) => Promise<unknown>;

export interface CreateLlmClientOptions {
  /** Extra attempts after the first, on a validation or provider failure. Default 3. */
  maxRetries?: number;
  /** Base backoff between retries in ms; doubles each attempt. Default 800. Set 0 in tests. */
  retryDelayMs?: number;
  /** Upper bound on a single backoff wait, before jitter. Default 20s. */
  maxRetryDelayMs?: number;
  /** Deadline for one attempt, in ms. Default 60s. 0 or less disables it. */
  timeoutMs?: number;
  /** Sustained outbound request rate. 0 or less disables throttling. Default 0. */
  requestsPerMinute?: number;
  /** Consecutive provider failures before the circuit opens. 0 disables it. Default 5. */
  circuitBreakerThreshold?: number;
  /** How long the circuit stays open before probing again. Default 30s. */
  circuitBreakerResetMs?: number;
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

  const running = operation(controller.signal);
  // The loser of the race still settles; swallow a late rejection so it doesn't
  // surface as an unhandled rejection. The race itself still sees the original.
  running.catch(() => undefined);

  try {
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
      const { object } = await generateObject({
        model: resolveModel(config),
        schema: llmIssueAnalysisSchema,
        system,
        prompt,
        abortSignal: signal,
        // We own the retry loop below, so don't let the SDK stack its own on top.
        maxRetries: 0,
      });
      return object;
    });

  /** One attempt: wait for rate-limit budget, call the provider, validate the shape. */
  async function attempt(prompt: string): Promise<LlmIssueAnalysis> {
    await throttle.acquire();

    const raw = await withTimeout(timeoutMs, (signal) =>
      generate({ system: ANALYSIS_SYSTEM_PROMPT, prompt, signal }),
    ).catch((error: unknown) => {
      // Anything thrown by the provider becomes a typed provider error, so the
      // breaker and the retry loop can classify it without duck-typing.
      if (error instanceof LlmTimeoutError) throw error;
      throw classifyProviderError(error);
    });

    const parsed = llmIssueAnalysisSchema.safeParse(coerceRawOutput(raw));
    if (!parsed.success) throw new LlmValidationError(parsed.error.message, parsed.error);
    return parsed.data;
  }

  return {
    async analyzeIssueGroup(input: IssueGroupInput): Promise<LlmIssueAnalysis> {
      const prompt = buildAnalysisPrompt(input);
      let lastError: unknown;
      let attempts = 0;

      for (let tries = 0; tries <= maxRetries; tries++) {
        attempts++;
        try {
          // The breaker wraps each attempt rather than the whole loop, so a
          // provider that dies mid-retry short-circuits the remaining attempts.
          return await breaker.execute(() => attempt(prompt));
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

      throw new LlmAnalysisError(attempts, lastError);
    },
  };
}
