import { ProviderError, type AgentEvent, type Provider, type ProviderEvent, type ProviderRequest } from "../types.ts";

const ATTEMPTS_PER_MODEL = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type RetryEvent = Extract<AgentEvent, { type: "retry" }>;

/**
 * Stream from the first model that works.
 * - 429 / 5xx / network error → wait (2s, 4s) and retry the same model
 * - other errors (bad model id, no tool support…) → try the next model right away
 * - once text has started streaming, we never retry (the user has already seen it)
 */
export async function* streamWithRetry(
  provider: Provider,
  models: string[],
  req: Omit<ProviderRequest, "model">,
): AsyncGenerator<ProviderEvent | RetryEvent> {
  let lastError: unknown;

  for (let m = 0; m < models.length; m++) {
    const model = models[m];

    for (let attempt = 1; attempt <= ATTEMPTS_PER_MODEL; attempt++) {
      let started = false;
      try {
        for await (const ev of provider.stream({ ...req, model })) {
          started = true;
          yield ev;
        }
        return; // success
      } catch (err) {
        if (started || req.signal?.aborted) throw err;
        lastError = err;
        const status = err instanceof ProviderError ? err.status : 0;
        const transient = status === 429 || status >= 500 || status === 0;
        if (!transient) break; // this won't fix itself, so try the next model

        if (attempt < ATTEMPTS_PER_MODEL) {
          const delayMs = 2000 * 2 ** (attempt - 1);
          yield { type: "retry", model, reason: `HTTP ${status || "network error"}, retrying`, delayMs };
          await sleep(delayMs);
        }
      }
    }

    if (m < models.length - 1) {
      const reason = lastError instanceof Error ? lastError.message.slice(0, 120) : "failed";
      yield { type: "retry", model: models[m + 1], reason: `switching model (${reason})`, delayMs: 0 };
    }
  }

  throw lastError ?? new Error("No models configured");
}
