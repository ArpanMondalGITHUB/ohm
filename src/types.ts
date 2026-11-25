// ---------- Conversation ----------

/** A tool call the model asked for. `arguments` is the raw JSON string the model wrote. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** One message in the conversation history we send to the model. */
export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

// ---------- Tools ----------

/** What the model sees: name, description and a JSON Schema for the arguments. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Things a tool might need while running. */
export interface ToolContext {
  cwd: string;                                  // the project folder
  confirm: (question: string) => Promise<boolean>; // ask the user y/N
  signal?: AbortSignal;
}

/** A tool = its definition + the code that runs it. Returns text for the model. */
export interface Tool extends ToolDefinition {
  execute(args: Record<string, any>, ctx: ToolContext): Promise<string>;
}

// ---------- Providers (LLM APIs) ----------

/** Why the model stopped. Every provider uses different words, so the provider maps them to these. */
export type StopReason =
  | "stop"            // finished normally
  | "tool_calls"      // wants tools to run
  | "length"          // hit the output token limit: the reply may be CUT OFF
  | "content_filter"  // blocked by the provider's safety filter
  | "other";          // anything we don't recognise

/** Tokens used by one model call. */
export interface Usage {
  inputTokens: number;        // what we sent (the WHOLE history, every turn)
  outputTokens: number;       // what the model wrote (includes thinking tokens)
  cachedInputTokens?: number; // part of the input the provider had cached (cheaper)
  reasoningTokens?: number;   // "thinking" tokens; billed as output even when hidden
  costUsd?: number;           // only some providers report this (e.g. OpenRouter)
}

/** How hard the model should "think" before answering. */
export type ReasoningEffort = "low" | "medium" | "high";

/** Small events a provider emits while streaming one reply. */
export type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }  // the model's thinking, if the provider shows it
  | { type: "tool_call"; call: ToolCall }      // emitted once the call is complete
  | { type: "done"; stopReason: StopReason; usage?: Usage };

export interface ProviderRequest {
  model: string;
  messages: Message[];
  tools: ToolDefinition[];
  reasoningEffort?: ReasoningEffort;           // undefined = the model's default
  signal?: AbortSignal;
}

/** Anything that can stream a model reply. OpenRouter, Groq, Ollama… all fit this. */
export interface Provider {
  name: string;
  stream(req: ProviderRequest): AsyncIterable<ProviderEvent>;
}

/** An HTTP error from the LLM API. `status` lets retry logic tell a 429 from a 400. */
export class ProviderError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

// ---------- Agent events (what the loop yields) ----------

export type AgentEvent =
  | { type: "turn_start"; turn: number }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; callId: string; name: string; output: string; isError: boolean }
  | { type: "turn_end"; turn: number; stopReason: StopReason; usage?: Usage }
  | { type: "message"; message: Message }          // a message was added to history
  | { type: "retry"; model: string; reason: string; delayMs: number }
  | { type: "error"; message: string }
  | { type: "agent_end" };
