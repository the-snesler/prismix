import { sleep } from "./util";
import { RateLimitError } from "./generation";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_BACKOFF_MS = 1000;

export interface RetryWaitInfo {
  retryCount: number;
  waitMs: number;
  waitingUntil: number;
  reason: "rate-limit" | "backoff";
}

export interface RetryOptions {
  maxRetries?: number;
  baseBackoffMs?: number;
  shouldContinue?: () => boolean;
  /** Return false to fail immediately on errors that can't succeed on a retry. */
  shouldRetry?: (error: unknown) => boolean;
  onWaiting?: (info: RetryWaitInfo) => void;
  onRetrying?: (info: { retryCount: number }) => void;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseBackoffMs = opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;

  let retryCount = 0;

  while (true) {
    if (opts.shouldContinue && !opts.shouldContinue()) {
      throw new Error("Retry cancelled");
    }

    try {
      return await fn();
    } catch (error) {
      if (error instanceof RateLimitError) {
        const waitMs = error.retryAfter * 1000;
        opts.onWaiting?.({
          retryCount,
          waitMs,
          waitingUntil: Date.now() + waitMs,
          reason: "rate-limit",
        });
        await sleep(waitMs);
        if (opts.shouldContinue && !opts.shouldContinue()) {
          throw new Error("Retry cancelled");
        }
        opts.onRetrying?.({ retryCount });
        // Don't increment retryCount for rate limits
        continue;
      }

      if (retryCount < maxRetries && (opts.shouldRetry?.(error) ?? true)) {
        const waitMs = baseBackoffMs * Math.pow(2, retryCount);
        retryCount++;
        opts.onWaiting?.({
          retryCount,
          waitMs,
          waitingUntil: Date.now() + waitMs,
          reason: "backoff",
        });
        await sleep(waitMs);
        if (opts.shouldContinue && !opts.shouldContinue()) {
          throw new Error("Retry cancelled");
        }
        opts.onRetrying?.({ retryCount });
        continue;
      }

      throw error;
    }
  }
}

/**
 * Inspect an arbitrary error from a provider SDK and, if it represents a 429
 * rate-limit response, convert it to a RateLimitError carrying the server's
 * Retry-After hint. Returns the original error otherwise.
 */
export function toRateLimitError(error: unknown, providerName: string): unknown {
  if (!(error instanceof Error)) return error;

  const errorAny = error as { status?: number; code?: number; message?: string };
  const message = errorAny.message ?? "";
  const isRateLimit =
    errorAny.status === 429 ||
    errorAny.code === 429 ||
    message.includes("429") ||
    message.toLowerCase().includes("rate limit");

  if (!isRateLimit) return error;

  let retryAfter = 10;

  // Try "retry-after: N" / "retry after N"
  const retryMatch = message.match(/retry.?after[:\s]*(\d+)/i);
  if (retryMatch) {
    retryAfter = Math.ceil(parseInt(retryMatch[1], 10));
  } else {
    // Try a JSON blob with retry_after
    try {
      const jsonMatch = message.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.retry_after) retryAfter = Math.ceil(parsed.retry_after);
      }
    } catch {
      /* fall through to default */
    }
  }

  return new RateLimitError(`Rate limited by ${providerName}`, retryAfter);
}
