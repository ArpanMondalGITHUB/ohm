import { extractTextToolCalls, parseToolArgs } from "./repair.ts";
import { streamWithRetry } from "./retry.ts";
import type { AgentEvent, Message, Provider, ReasoningEffort, ReplayData, StopReason, Tool, ToolCall, ToolContext, ToolDefinition, Usage } from "../types.ts";

export interface AgentOptions {
  provider: Provider;
  models: string[];
  tools: Tool[];
  cwd: string;
  confirm: (question: string) => Promise<boolean>;
  textTools?: boolean;
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
  getSteeringMessages?: () => Message[] | Promise<Message[]>;
  getFollowUpMessages?: () => Message[] | Promise<Message[]>;
}

export async function* runAgent(messages: Message[], opts: AgentOptions): AsyncGenerator<AgentEvent> {
  const toolMap = new Map(opts.tools.map((t) => [t.name, t]));
  const definitions: ToolDefinition[] = opts.tools.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
  const ctx: ToolContext = { cwd: opts.cwd, confirm: opts.confirm, signal: opts.signal };
  const textMode = opts.textTools ?? false;

  let turn = 0;
  let pendingMessages: Message[] = (await opts.getSteeringMessages?.()) ?? [];

  while (true) {
    let hasMoreToolCalls = true;

    while (hasMoreToolCalls || pendingMessages.length > 0) {
      turn++;
      yield { type: "turn_start", turn };

      for (const message of pendingMessages) {
        messages.push(message);
        yield { type: "message", message };
      }
      pendingMessages = [];

      let text = "";
      const calls: ToolCall[] = [];
      let stopReason: StopReason = "stop";
      let usage: Usage | undefined;
      let replay: ReplayData | undefined;
      for await (const ev of streamWithRetry(opts.provider, opts.models, {
        messages,
        tools: textMode ? [] : definitions, // in text mode the API never sees the tools
        reasoningEffort: opts.reasoningEffort,
        signal: opts.signal,
      })) {
        if (ev.type === "text_delta") {
          text += ev.text;
          yield ev;
        } else if (ev.type === "reasoning_delta") {
          yield ev;
        } else if (ev.type === "tool_call") {
          calls.push(ev.call);
        } else if (ev.type === "retry") {
          yield ev;
        } else if (ev.type === "done") {
          stopReason = ev.stopReason;
          usage = ev.usage;
          replay = ev.replay;
        }
      }

      // Rescue: some models write tool calls as text instead of using the API
      if (calls.length === 0) calls.push(...extractTextToolCalls(text));

      const assistant: Message = {
        role: "assistant",
        content: text,
        ...(calls.length && !textMode ? { toolCalls: calls } : {}),
        ...(replay ? { replay } : {}),
      };
      messages.push(assistant);
      yield { type: "message", message: assistant };

      hasMoreToolCalls = calls.length > 0;

      for (const call of calls) {
        yield { type: "tool_call", call };
        // pi's safety check: if the reply hit the output token limit, its tool calls may be
        // cut off halfway (imagine a `write` with half a file). Don't run them; ask again.
        const result =
          stopReason === "length"
            ? {
                isError: true,
                output: `Error: "${call.name}" was not run because your reply hit the output token limit, so its arguments may be incomplete. Send the call again with complete arguments.`,
              }
            : await executeToolCall(call, toolMap, ctx);

        // Native mode: a proper "tool" message. Text mode: plain text the model can read.
        const resultMessage: Message = textMode
          ? { role: "user", content: `<tool_result name="${call.name}">\n${result.output}\n</tool_result>` }
          : { role: "tool", toolCallId: call.id, content: result.output };

        messages.push(resultMessage);
        yield { type: "tool_result", callId: call.id, name: call.name, ...result };
        yield { type: "message", message: resultMessage };
      }

      yield { type: "turn_end", turn, stopReason, usage };

      pendingMessages = (await opts.getSteeringMessages?.()) ?? [];
    }

    const followUps = (await opts.getFollowUpMessages?.()) ?? [];
    if (followUps.length > 0) {
      pendingMessages = followUps;
      continue;
    }
    break;
  }

  yield { type: "agent_end" };
}

async function executeToolCall(
  call: ToolCall,
  toolMap: Map<string, Tool>,
  ctx: ToolContext,
): Promise<{ output: string; isError: boolean }> {
  const tool = toolMap.get(call.name);
  if (!tool) {
    return { isError: true, output: `Error: unknown tool "${call.name}". Available: ${[...toolMap.keys()].join(", ")}` };
  }

  const parsed = parseToolArgs(call.arguments);
  if (!parsed.ok) {
    return { isError: true, output: `Error: could not parse arguments as JSON (${parsed.error}). Send a valid JSON object matching the tool's parameters.` };
  }

  const missing = (tool.parameters.required ?? []).filter((key) => parsed.value[key] === undefined);
  if (missing.length) {
    return { isError: true, output: `Error: missing required argument(s): ${missing.join(", ")}` };
  }

  try {
    return { isError: false, output: truncate(await tool.execute(parsed.value, ctx)) };
  } catch (err) {
    return { isError: true, output: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function truncate(text: string, max = 30_000): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n... [${text.length - max} characters cut] ...\n\n${text.slice(-half)}`;
}
