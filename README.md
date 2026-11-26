# ohm

A small coding agent for your terminal, written in TypeScript. You give it a task; it streams its answer, reads and edits files, runs commands in your project, and keeps looping until the task is done. It works with several model providers (Anthropic, OpenRouter, OpenAI, Gemini, Ollama, or any OpenAI-compatible API), and you can switch between them mid-conversation.

ohm follows the design of [pi](https://github.com/badlogic/pi-mono): a minimal harness with a handful of tools, where every part — streaming, tool calling, the agent loop — is small enough to read and understand.

---

## Contents

- [Quick start](#quick-start)
- [Using ohm](#using-ohm)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Project structure](#project-structure)
- [Extending ohm](#extending-ohm)
- [Safety](#safety)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Design decisions](#design-decisions)
- [Roadmap](#roadmap)

---

## Quick start

### Requirements

- **Node.js 20.12 or newer.** ohm uses `process.loadEnvFile`, which older versions lack.
- **An API key** for at least one provider (see [Providers](#providers)), unless you use a local Ollama server.
- **Windows:** [Git for Windows](https://gitforwindows.org/) is recommended, so the `bash` tool can use Git Bash. Without it, ohm falls back to PowerShell.

### Install

```powershell
git clone <your-repo-url> ohm
cd ohm
npm install
npm link        # creates a global `ohm` command on this computer (nothing is published)
```

`npm link` creates a shortcut to this folder, so changes you make to `src/` take effect the next time you run `ohm`. Remove it with `npm unlink -g ohm`.

### First run

Go to any project and start ohm there — it works on the folder you start it in:

```powershell
cd C:\path\to\some-project
ohm
```

The first time, ohm asks which provider to use, your API key and a model ID, then saves them to `~/.ohm/auth.json`:

```
Connect a model provider:

  1. Anthropic (Claude)
  2. OpenRouter (one key, many models)
  3. OpenAI
  4. Google Gemini
  5. Ollama (local, no key)
  6. Other (any OpenAI-compatible API)

Choose [1]:
```

After that it starts straight away. Use a git repository, so you can review and undo anything the agent changes (`git diff`, `git checkout .`).

---

## Using ohm

### A typical session

```
> add a function sum(a, b) to math.js and a test for it, then run the tests

● read math.js
● write math.test.js {"path":"math.test.js","content":"..."}
● bash {"command":"node --test"}
Run: node --test [y/N] y
exit code: 0
...
Added sum() and a test; all tests pass.
[in 5120 · out 410 · cached 4300]
```

- Lines starting with `●` are tool calls; the dimmed lines under them are a preview of the result.
- The `[in … · out … · cached …]` line after each turn shows tokens used (and cost, for providers that report it). `in` grows every turn because the whole conversation is sent again; `cached` is the part the provider served cheaply from its cache.
- If a reply hit the output token limit you'll see `⚠ reply was cut off`.

### Commands

| Command | What it does |
|---|---|
| `ohm` | Start a new session in the current folder |
| `ohm --resume` | Continue the most recent session |
| `ohm replay [file]` | Print a session log (the latest one if no file is given) and exit |
| `/model` | Show the current model and which providers have a key |
| `/model <provider>/<model-id>` | Switch model or provider. The conversation continues on the new model, and the next run starts with it |
| `/login` | Add or replace a provider's API key (keys for other providers are kept) |
| `/exit` or Ctrl+C | Quit |

---

## Configuration

ohm looks for settings in this order — the first one found wins:

1. **Environment variables** — from your shell or from the `.env` file **in the ohm folder** (not the project you're working in)
2. **`~/.ohm/auth.json`** — written by the first-run setup and `/login`
3. **The setup questions** — if neither of the above has a key and model

### Models are written as `provider/model`

```
anthropic/<claude-model-id>
openrouter/<vendor>/<model-id>      ← only the first "/" separates the provider
openai/<model-id>
ollama/<model-id>
```

Copy the model ID from your provider's model list. Pick a model that supports **tool calling** — the agent can't work without it.

### Providers

| Provider id | API format | Key variable | Notes |
|---|---|---|---|
| `anthropic` | Anthropic Messages (native) | `ANTHROPIC_API_KEY` | Prompt caching and thinking are handled natively |
| `openrouter` | OpenAI-compatible | `OPENROUTER_API_KEY` | One key for many vendors' models; reports cost per turn |
| `openai` | OpenAI-compatible | `OPENAI_API_KEY` | |
| `gemini` | OpenAI-compatible | `GEMINI_API_KEY` | Uses Gemini's OpenAI-compatible endpoint |
| `ollama` | OpenAI-compatible | — | Local server at `http://localhost:11434/v1`, no key |
| any other name | OpenAI-compatible | — | Choose "Other" in `/login` and give a base URL |

### Environment variables

All are optional.

| Variable | Default | Meaning |
|---|---|---|
| `OHM_MODEL` | saved default | Model to start with, as `provider/model`. Overrides `auth.json` |
| `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` | — | The provider's key. Overrides the key in `auth.json` |
| `OHM_FALLBACK_MODELS` | — | Comma-separated model IDs **of the same provider**, tried when the main model keeps failing |
| `OHM_REASONING_EFFORT` | model default | `low`, `medium` or `high`: how much the model thinks before answering. More thinking costs more tokens |
| `OHM_YOLO` | `0` | `1` = run `bash` commands without asking first |
| `OHM_SHELL` | Git Bash on Windows, `bash` elsewhere | Path to a bash-compatible shell for the `bash` tool |
| `OHM_TEXT_TOOLS` | `0` | `1` = describe tools inside the prompt instead of the API, for models without native tool calling |

Example `.env` (in the ohm folder):

```bash
OHM_MODEL=anthropic/<claude-model-id>
OHM_REASONING_EFFORT=medium
OHM_FALLBACK_MODELS=
OHM_YOLO=0
```

### Files ohm creates

| Path | Contents |
|---|---|
| `~/.ohm/auth.json` | API keys per provider and the default model. Plain text in your home folder (the same approach as Claude Code and pi on Windows/Linux) — never inside a project, so it can't be committed by accident |
| `~/.ohm/sessions/<timestamp>.jsonl` | One log per session: every message, tool call, result and error |
| `~/.ohm/tools/*.ts` | Your plugin tools, loaded in every project (see [Extending ohm](#extending-ohm)) |

---

## How it works

### The layers

Each layer only talks to the one below it, through the types in `src/types.ts`:

```
┌───────────────────────────────────────────────────────────┐
│ cli.ts        reads your input, prints events, /commands  │
│   │ runAgent(messages, { provider, tools })  ▲ AgentEvent │
│   ▼                                          │            │
│ agent/loop.ts  ask model → run tools → ask again → …      │
│   │ provider.stream()  ▲ ProviderEvent   │ tool.execute() │
│   ▼                    │                 ▼                │
│ providers/             │              tools/              │
│   registry.ts → openai-compat.ts      read, write, edit,  │
│              → anthropic.ts           bash, + plugins     │
└───────────────────────────────────────────────────────────┘
```

| Type | Role |
|---|---|
| `Message` | One entry in the conversation (system, user, assistant, tool). The model has no memory — the whole `Message[]` is sent every turn |
| `Provider` | Anything with `stream(request)` that yields `ProviderEvent`s. **The plug point for models** |
| `Tool` | A name, a JSON Schema for its arguments, and `execute()`. **The plug point for tools** |
| `AgentEvent` | What the loop reports (`text_delta`, `tool_call`, `tool_result`, `turn_end`…). **The plug point for UIs** |

### Streaming

Providers reply with Server-Sent Events: lines like `data: {...}` arriving over an open connection. Network chunks don't line up with lines, so `providers/sse.ts` keeps a buffer and only hands out complete lines. Text is shown as soon as it arrives; tool calls are held until the stream ends, because their JSON arguments arrive in pieces.

### The agent loop

`agent/loop.ts` has the same structure as pi's loop:

```
while (true) {                                          // outer: follow-up messages
  while (hasMoreToolCalls || pendingMessages.length) {  // inner: the agent loop
    1. send the conversation + tool list to the model, stream the reply
    2. save the reply in the conversation
    3. no tool calls?  → this round is done
    4. run each tool, add its result to the conversation, go again
  }
  if (follow-up messages are waiting) continue; else break;
}
```

- **The model decides when it's done** — the loop ends when a reply asks for no tools. There's no turn limit (like pi), so watch long runs and press Ctrl+C if a model gets stuck.
- **Tool errors don't crash anything.** An unknown tool, invalid JSON or a failing command becomes an `Error: …` result that the model reads and usually fixes on its next turn.
- **The loop never prints.** It only yields events. The terminal renderer (`render.ts`) and the session logger (`session.ts`) both listen to the same events; a web UI would be a third listener.
- **Cut-off replies:** if a reply hit the output token limit, its tool calls may have half-written arguments, so they are not run — the model is asked to send them again.

### Providers and adapters

There are two different things:

- An **API format** — how requests and streamed replies are shaped. One adapter file per format: `openai-compat.ts` (raw `fetch`) and `anthropic.ts` (official `@anthropic-ai/sdk`).
- A **provider** — an endpoint, a key and the format it speaks. One line each in `providers/registry.ts`.

Each adapter converts ohm's shared `Message[]` into its API's format and the API's stream back into `ProviderEvent`s, including:

- **Stop reasons** mapped to five values: `stop`, `tool_calls`, `length`, `content_filter`, `other`
- **Usage** (input, output, cached and thinking tokens; cost where reported)
- **Thinking**, shown dimmed but not saved in the history

Claude has two extra requirements, handled in `anthropic.ts`:
- **Thinking blocks must be sent back unchanged.** The adapter stores Claude's raw reply in the message's `replay` field and sends it back as-is. Other adapters ignore `replay`.
- **Prompt caching:** one cache breakpoint on the system prompt plus automatic caching of the conversation, so from the second turn most input is read from cache.

Because everything goes through the shared types, `/model` can switch providers in the middle of a conversation.

### Retries and repair

- `agent/retry.ts` retries HTTP 429, 5xx and network errors (waiting 2 s, then 4 s), then moves on to `OHM_FALLBACK_MODELS`. It never retries once text has started streaming, so you don't see a reply twice.
- `agent/repair.ts` rescues sloppy tool calls: JSON wrapped in code fences, text around the JSON, trailing commas, double-encoded JSON, and tool calls written as `<tool_call>…</tool_call>` text.

---

## Project structure

```
ohm/
├── bin/ohm.js                  the `ohm` command: registers tsx, then loads src/cli.ts
├── src/
│   ├── cli.ts                  terminal app: input, /commands, sessions, wiring
│   ├── config.ts               works out provider + key + model (env → auth.json → setup)
│   ├── auth.ts                 ~/.ohm/auth.json, first-run setup, /login
│   ├── types.ts                shared types: Message, Tool, Provider, AgentEvent…
│   ├── render.ts               prints agent events (colors, previews, usage line)
│   ├── session.ts              JSONL session logs, --resume, replay
│   ├── plugin.ts               loads plugin tools from ~/.ohm/tools and .ohm/tools
│   ├── agent/
│   │   ├── loop.ts             the agent loop
│   │   ├── system-prompt.ts    instructions for the model (+ the project's AGENTS.md)
│   │   ├── retry.ts            retries and fallback models
│   │   └── repair.ts           fixes malformed tool calls
│   ├── providers/
│   │   ├── registry.ts         provider list, provider/model parsing, createProvider()
│   │   ├── openai-compat.ts    OpenAI-format adapter (raw fetch)
│   │   ├── sse.ts              Server-Sent Events parser
│   │   └── anthropic.ts        Anthropic adapter (official SDK)
│   └── tools/
│       ├── index.ts            the built-in tool list
│       ├── read.ts             read a file (2000 lines at a time)
│       ├── write.ts            create or overwrite a file
│       ├── edit.ts             replace exactly one occurrence of some text
│       ├── bash.ts             run a command (asks first, 60 s timeout)
│       ├── shell.ts            picks Git Bash / bash / PowerShell
│       └── paths.ts            keeps file tools inside the project folder
├── test/                       vitest tests, one file per module (+ helpers.ts)
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Extending ohm

### Add a tool (no changes to ohm needed)

Put a `.ts` file in `~/.ohm/tools/` (all projects) or `<project>/.ohm/tools/` (one project). It must `export default` an object with the tool's shape:

```ts
// ~/.ohm/tools/now.ts
export default {
  name: "now",
  description: "Get the current local date and time.",
  parameters: { type: "object", properties: {}, required: [] },
  async execute() {
    return new Date().toString();
  },
};
```

The `description` and `parameters` are what the model reads to decide when and how to call it. Whatever `execute()` returns is sent to the model as the result; if it throws, the model gets the error message. A file that fails to load prints a warning and is skipped.

### Add an OpenAI-compatible provider

Add one line to `PROVIDERS` in `src/providers/registry.ts`:

```ts
{ id: "groq", label: "Groq", api: "openai", baseUrl: "https://api.groq.com/openai/v1", envKey: "GROQ_API_KEY" },
```

It then appears in `/login` and works as `groq/<model-id>`. (For a one-off you can also choose "Other" in `/login`.)

### Add a new API format

1. Write `src/providers/<name>.ts` exporting a function that returns a `Provider`. It converts `Message[]` to the API's format and the API's stream to `ProviderEvent`s — `anthropic.ts` is the example to follow.
2. Add the name to `type ApiFormat` in `registry.ts`. TypeScript will then report an error in `createProvider()` until you add the matching `case`.
3. Point the provider's registry line at the new format.

The loop, tools, renderer and sessions don't change.

### Project instructions

If the project you run ohm in has an `AGENTS.md` file, its contents are added to the system prompt — use it for project rules ("run `npm test` after changes", "never edit `generated/`").

---

## Safety

ohm runs on your real files with your user account — there is no sandbox.

- **`bash` asks before every command** (`Run: … [y/N]`) unless `OHM_YOLO=1`. Once approved, a command can do anything you can do.
- **File tools can't leave the project folder** — `read`, `write` and `edit` reject paths outside the folder ohm was started in.
- **Work in a git repository** so every change can be reviewed and undone.
- **Project plugins run code.** `<project>/.ohm/tools/` is loaded automatically, so only run ohm in repositories you trust.
- **Costs are real.** An agent re-sends the whole conversation every turn and there is no turn limit. Set a spending limit in your provider's dashboard, and start a new session for each task.
- On Windows, a command that times out is killed, but processes it started (for example a dev server) may keep running.

---

## Development

```powershell
npm run dev          # run ohm from source in the ohm folder itself
npm run typecheck    # type-check everything (no output = no errors)
npm test             # run all tests (vitest)
```

The tests run offline and need no API key: model APIs are replaced with fake responses, and anything that uses `~/.ohm` is redirected to a temporary folder, so your real keys and sessions are never touched. The `bash` tool tests run real commands and are skipped when only PowerShell is available.

How the TypeScript setup works:

- **`tsx` runs the `.ts` files directly** — there's no build step and no `dist/` folder.
- **`tsc` only checks types** (`noEmit`). tsx does **not** type-check, so code with a type error still runs — use `npm run typecheck` (and your editor's red underlines).
- **Imports use the real file names** (`import { x } from "./types.ts"`), allowed by `allowImportingTsExtensions`.
- **`"types": ["node"]`** in `tsconfig.json` is required: TypeScript 6+ no longer loads `@types/node` automatically.
- **`bin/ohm.js` is the only JavaScript file.** Plain `node` starts it before TypeScript support is loaded; it calls tsx's `register()` and then imports `src/cli.ts`.

---

## Troubleshooting

| Problem | Cause and fix |
|---|---|
| First-run setup never appears | `OHM_MODEL` plus a key are already set in `.env` or your shell. Remove them, or use `/login` |
| `Unknown provider "x" in "x/…"` | `OHM_MODEL` must start with a provider id: `openrouter/<model>`, not just `<model>` |
| `No API key saved for that provider` after `/model` | Run `/login` and add a key for that provider first |
| `HTTP 401` on the first message | Wrong or expired key. Run `/login` and paste it again |
| `HTTP 400` mentioning tools | The model doesn't support tool calling. Switch with `/model` (or try `OHM_TEXT_TOOLS=1`) |
| `cached 0` on every turn with Claude | Something early in the request changes between turns, so the cache never matches. The system prompt must stay identical during a session |
| The model keeps calling the same tool | Press Ctrl+C. Try a stronger model or a clearer request |
| `Cannot find name 'node:…'` in the editor | `"types": ["node"]` is missing from `tsconfig.json` |
| `Cannot find module './types'` | Imports need the full file name: `./types.ts`. In VS Code, run **TypeScript: Restart TS Server** after changing `tsconfig.json` |
| `bash` commands fail on Windows | Install Git for Windows, or set `OHM_SHELL` to a bash executable |

---

## Design decisions

| Decision | Why |
|---|---|
| Terminal CLI, no web server | Terminal agents only make *outgoing* HTTP calls. A web UI can be added later as another listener on the same events |
| Agent loop as an async generator of events | The loop never touches the terminal, so the UI, logging and a future server all reuse it unchanged |
| pi's loop structure, no turn limit | The model decides when it's done; Ctrl+C is the safety valve |
| Tool errors become tool results | Models recover from their own mistakes when they can read the error |
| Raw `fetch` for the OpenAI format; the official SDK for Anthropic | The OpenAI format is simple to stream by hand; the SDK correctly assembles Claude's thinking signatures, which must be sent back unchanged |
| One adapter per API format, one registry line per provider | Most providers speak the OpenAI format, so adding one is a single line |
| API keys only, saved in `~/.ohm/auth.json` | Simple and allowed everywhere. Subscription logins (OAuth) depend on each provider's terms and are not supported |
| `tsx` instead of a build step | Edit a `.ts` file and run it again |

---

## Roadmap

1. Esc to stop the current run without quitting
2. Session totals for tokens and cost, shown on `/exit`
3. `/model` listing the provider's available models
4. Context compaction for very long sessions
5. A web UI through a small server that streams the same events
6. Claude extras: streaming large tool inputs as they're generated, and server-side fallbacks on refusals

Not planned: subscription (OAuth) logins, a native Gemini adapter (the OpenAI-compatible endpoint covers it), and publishing to npm.

## License

No license has been chosen yet.
