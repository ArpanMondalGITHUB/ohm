import { parseSSE } from "./sse.ts";
import { ProviderError, type Message, type Provider, type StopReason, type ToolCall, type Usage } from "../types.ts";

export interface OpenAICompatOptions {
  baseUrl: string;   // e.g. https://openrouter.ai/api/v1
  apiKey: string;
  name?: string;
}

export function createOpenAICompatProvider(opts: OpenAICompatOptions): Provider {
  return {
    name: opts.name ?? "openai-compat",

    async *stream({ model, messages, tools, reasoningEffort, signal }) {
      const isOpenRouter = opts.baseUrl.includes("openrouter.ai");

      // 1. Send the request
      const res = await fetch(`${opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
          model,
          stream: true,
          // Ask for token usage in the last chunk (OpenAI only sends it if you ask)
          stream_options: { include_usage: true },
          messages: messages.map(toApiMessage),
          tools: tools.length
            ? tools.map((t) => ({
                type: "function",
                function: { name: t.name, description: t.description, parameters: t.parameters },
              }))
            : undefined,
          // Thinking: only sent when you turn it on. OpenRouter uses its own field for it.
          ...(reasoningEffort
            ? isOpenRouter
              ? { reasoning: { effort: reasoningEffort } }
              : { reasoning_effort: reasoningEffort }
            : {}),
        }),
        signal,
      });

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        throw new ProviderError(res.status, `HTTP ${res.status}: ${text.slice(0, 500)}`);
      }

      // 2. Read the stream. Tool calls arrive in pieces, so collect them by index.
      const pending = new Map<number, ToolCall>();
      let stopReason: StopReason = "stop";
      let usage: Usage | undefined;

      for await (const data of parseSSE(res.body)) {
        if (data === "[DONE]") break;

        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue; // ignore lines that aren't JSON
        }

        // Some providers send errors in the middle of the stream
        if (chunk.error) {
          throw new ProviderError(Number(chunk.error.code) || 500, chunk.error.message ?? JSON.stringify(chunk.error));
        }

        // Usage comes in the LAST chunk, usually with an EMPTY `choices` array,
        // so read it BEFORE the line below skips chunks without a choice.
        if (chunk.usage) usage = toUsage(chunk.usage);

        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};

        // Thinking: providers use different field names for the same thing
        const reasoning = delta.reasoning ?? delta.reasoning_content;
        if (typeof reasoning === "string" && reasoning) yield { type: "reasoning_delta", text: reasoning };
        if (delta.refusal) yield { type: "text_delta", text:delta.refusal};

        // Text: pass each piece through right away so the user sees it live
        if (delta.content) yield { type: "text_delta", text: delta.content };

        // Tool calls: join the pieces together
        for (const tc of delta.tool_calls ?? []) {
          // Some providers (e.g. Gemini) leave out `index`; work it out ourselves
          const index: number =
            tc.index ?? (tc.id || pending.size === 0 ? pending.size : pending.size - 1);
          let call = pending.get(index);
          if (!call) {
            call = { id: tc.id ?? `call_${Date.now()}_${index}`, name: "", arguments: "" };
            pending.set(index, call);
          }
          if (tc.id) call.id = tc.id;
          if (tc.function?.name && !call.name) call.name = tc.function.name;
          if (tc.function?.arguments) call.arguments += tc.function.arguments;
        }

        if (choice.finish_reason) stopReason = toStopReason(choice.finish_reason);
      }

      // 3. Tool calls are only complete once the stream ends
      for (const call of pending.values()) yield { type: "tool_call", call };
      yield { type: "done", stopReason, usage };
    },
  };
}

/** Translate the provider's word for "why I stopped" into our StopReason. */
function toStopReason(raw: string): StopReason {
  switch (raw) {
    case "stop":
    case "end_turn":
      return "stop";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "length":
    case "max_tokens":
      return "length";
    case "content_filter":
      return "content_filter";
    default:
      return "other";
  }
}

/** Translate the API's usage object (snake_case) into our Usage. */
function toUsage(u: any): Usage {
  return {
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    cachedInputTokens: u.prompt_tokens_details?.cached_tokens,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens,
    costUsd: typeof u.cost === "number" ? u.cost : undefined,
  };
}

/** Convert our Message shape into the OpenAI API format. */
function toApiMessage(m: Message) {
  switch (m.role) {
    case "assistant":
      return {
        role: "assistant",
        content: m.content || null,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: c.arguments },
              })),
            }
          : {}),
      };
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    default:
      return { role: m.role, content: m.content };
  }
}
