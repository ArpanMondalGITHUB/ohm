import Anthropic from "@anthropic-ai/sdk";
import { ProviderError, type Message, type Provider, type StopReason, type Usage } from "../types.ts";

export interface AnthropicOptions {
  apiKey: string;
  baseUrl?: string;
}

/** Room for one reply (thinking + text + tool calls). Streaming makes a big value safe. */
const MAX_TOKENS = 64000;

export function createAnthropicProvider(opts: AnthropicOptions): Provider {
  // maxRetries: 0 → ohm's own retry.ts (Task 6) decides when to retry, not the SDK
  const client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseUrl, maxRetries: 0 });

  return {
    name: "anthropic",

    async *stream({ model, messages, tools, reasoningEffort, signal }) {
      const { system, apiMessages } = toAnthropicMessages(messages);

      const stream = client.messages.stream(
        {
          model,
          max_tokens: MAX_TOKENS,
          // The system prompt is the same all session → cache it with its own breakpoint...
          ...(system
            ? { system: [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }] }
            : {}),
          // ...and let the API cache the growing conversation automatically
          cache_control: { type: "ephemeral" },
          messages: apiMessages,
          ...(tools.length
            ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) }
            : {}),
          // Thinking depth: only sent when OHM_REASONING_EFFORT is set; otherwise the model's default
          ...(reasoningEffort
            ? {
                thinking: { type: "adaptive" as const, display: "summarized" as const },
                output_config: { effort: reasoningEffort },
              }
            : {}),
        },
        { signal },
      );

      try {
        // 1. Stream text and thinking live
        for await (const event of stream) {
          if (event.type !== "content_block_delta") continue;
          if (event.delta.type === "text_delta") {
            yield { type: "text_delta", text: event.delta.text };
          } else if (event.delta.type === "thinking_delta" && event.delta.thinking) {
            yield { type: "reasoning_delta", text: event.delta.thinking };
          }
        }

        // 2. The SDK assembles the complete reply: tool calls with parsed input, thinking with signatures
        const message = await stream.finalMessage();
        for (const block of message.content) {
          if (block.type === "tool_use") {
            yield { type: "tool_call", call: { id: block.id, name: block.name, arguments: JSON.stringify(block.input) } };
          }
        }
        yield {
          type: "done",
          stopReason: toStopReason(message.stop_reason),
          usage: toUsage(message.usage),
          // Next turn, this reply is sent back EXACTLY as received (thinking blocks must not change)
          replay: { api: "anthropic", data: message.content },
        };
      } catch (err) {
        // Turn SDK errors into our ProviderError, so retry.ts can read the status code
        if (err instanceof Anthropic.APIError) throw new ProviderError(err.status ?? 0, err.message);
        throw err;
      }
    },
  };
}

/** Our Message[] → Anthropic's { system, messages }. Exported so tests can check it. */
export function toAnthropicMessages(messages: Message[]): { system: string; apiMessages: Anthropic.MessageParam[] } {
  const systemParts: string[] = [];
  const out: Anthropic.MessageParam[] = [];

  for (const m of messages) {
    switch (m.role) {
      case "system":
        // Anthropic takes the system prompt as a separate field, not as a message
        systemParts.push(m.content);
        break;

      case "user":
        out.push({ role: "user", content: m.content });
        break;

      case "assistant": {
        // Claude's own earlier reply: send it back unchanged (keeps thinking blocks valid)
        if (m.replay?.api === "anthropic") {
          out.push({ role: "assistant", content: m.replay.data as Anthropic.ContentBlockParam[] });
          break;
        }
        // A reply from another provider (after /model): rebuild it as Anthropic blocks
        const content: Anthropic.ContentBlockParam[] = [];
        if (m.content) content.push({ type: "text", text: m.content });
        for (const c of m.toolCalls ?? []) {
          content.push({ type: "tool_use", id: safeId(c.id), name: c.name, input: parseInput(c.arguments) });
        }
        if (content.length) out.push({ role: "assistant", content }); // Anthropic rejects empty messages
        break;
      }

      case "tool": {
        const result: Anthropic.ToolResultBlockParam = {
          type: "tool_result",
          tool_use_id: safeId(m.toolCallId),
          content: m.content,
        };
        // All results for one assistant turn go in ONE user message
        const last = out[out.length - 1];
        if (last?.role === "user" && Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result")) {
          last.content.push(result);
        } else {
          out.push({ role: "user", content: [result] });
        }
        break;
      }
    }
  }
  return { system: systemParts.join("\n\n"), apiMessages: out };
}

/** Anthropic only allows letters, digits, _ and - in tool IDs. Other providers' IDs may have more. */
const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_");

function parseInput(args: string): Record<string, unknown> {
  try {
    const value = JSON.parse(args || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function toStopReason(raw: string | null): StopReason {
  switch (raw) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "refusal":
      return "content_filter";
    default:
      return "other"; // e.g. pause_turn (only for server-side tools, which ohm doesn't use)
  }
}

function toUsage(u: Anthropic.Usage): Usage {
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  return {
    // Anthropic splits input into 3 numbers; we show the total, like OpenAI does
    inputTokens: u.input_tokens + cacheRead + cacheWrite,
    outputTokens: u.output_tokens,
    cachedInputTokens: cacheRead,
  };
}
