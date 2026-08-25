import { describe, expect, it } from "vitest";
import {
  CircuitOpenError,
  LlmAnalysisError,
  LlmError,
  LlmProviderError,
  LlmTimeoutError,
  LlmValidationError,
  classifyProviderError,
} from "./errors";

describe("error taxonomy", () => {
  it("separates 'retry this' from 'the provider is unhealthy'", () => {
    // The whole point of the taxonomy: these two axes disagree in both directions.
    const badOutput = new LlmValidationError("no fixCode", undefined);
    expect(badOutput.retryable).toBe(true);
    expect(badOutput.tripsBreaker).toBe(false);

    const badKey = new LlmProviderError("401 Unauthorized", false, 401, undefined);
    expect(badKey.retryable).toBe(false);
    expect(badKey.tripsBreaker).toBe(true);
  });

  it("makes a timeout retryable and breaker-tripping", () => {
    const error = new LlmTimeoutError(5000);
    expect(error.retryable).toBe(true);
    expect(error.tripsBreaker).toBe(true);
    expect(error.message).toContain("5000ms");
  });

  it("never lets an open circuit retry or count against itself", () => {
    const error = new CircuitOpenError(30_000);
    expect(error.retryable).toBe(false);
    expect(error.tripsBreaker).toBe(false);
    expect(error.message).toContain("30s");
  });

  it("keeps the underlying failure reachable from the final error", () => {
    const cause = new LlmTimeoutError(1000);
    const error = new LlmAnalysisError(4, cause);
    expect(error.cause).toBe(cause);
    expect(error.attempts).toBe(4);
    expect(error.message).toContain("after 4 attempt(s)");
    expect(error.message).toContain("timed out");
  });

  it("keeps every variant instanceof LlmError, so callers can match on one type", () => {
    for (const error of [
      new LlmTimeoutError(1),
      new LlmValidationError("x", undefined),
      new LlmProviderError("x", true, 500, undefined),
      new CircuitOpenError(1),
      new LlmAnalysisError(1, undefined),
    ]) {
      expect(error).toBeInstanceOf(LlmError);
      expect(error).toBeInstanceOf(Error);
    }
  });
});

describe("classifyProviderError", () => {
  it("trusts the SDK's explicit retryable flag over the status code", () => {
    // A 408 is a 4xx, but the SDK knows it is worth another try.
    const retryable = classifyProviderError(
      Object.assign(new Error("Request Timeout"), { statusCode: 408, isRetryable: true }),
    );
    expect(retryable.retryable).toBe(true);

    // ...and the reverse: a 500 the SDK says not to retry.
    const notRetryable = classifyProviderError(
      Object.assign(new Error("Fatal"), { statusCode: 500, isRetryable: false }),
    );
    expect(notRetryable.retryable).toBe(false);
  });

  it("does not retry a 4xx that cannot succeed on retry", () => {
    for (const statusCode of [400, 401, 403, 404, 422]) {
      expect(
        classifyProviderError(Object.assign(new Error("nope"), { statusCode })).retryable,
      ).toBe(false);
    }
  });

  it("retries a 429 and any 5xx", () => {
    for (const statusCode of [429, 500, 502, 503, 504]) {
      expect(classifyProviderError(Object.assign(new Error("hmm"), { statusCode })).retryable).toBe(
        true,
      );
    }
  });

  it("retries an unclassifiable failure (a bare network error)", () => {
    const error = classifyProviderError(new Error("ECONNRESET"));
    expect(error.retryable).toBe(true);
    expect(error.statusCode).toBeUndefined();
    expect(error.message).toBe("ECONNRESET");
  });

  it("survives a non-Error being thrown", () => {
    const error = classifyProviderError("just a string");
    expect(error).toBeInstanceOf(LlmProviderError);
    expect(error.retryable).toBe(true);
    expect(error.message).toBe("just a string");
  });
});
