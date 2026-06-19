# pi-fastcontext

Pi extension for [Microsoft FastContext](https://github.com/microsoft/fastcontext): fast, read-only codebase search with compact `file:line` citations.

This extension **does not register FastContext as a normal Pi chat model**. Instead it exposes one tool, `fast_context_search`, that runs a small FastContext tool loop with the model's native tools:

- `GLOB(pattern)`
- `GREP(pattern, path?)`
- `READ(path, offset?, limit?)`

The wrapper executes those tools safely against the requested repository, forces a final answer after a bounded search budget, and validates returned citations.

## Why an extension?

FastContext is trained to use `READ/GLOB/GREP`, not Pi's built-in `read/grep/find/ls` directly. If you run it as a plain Pi subagent/model, it can loop on wrong paths like `/repo/src`. This extension provides the exact tool semantics FastContext expects.

## Requirements

1. A local OpenAI-compatible FastContext server, e.g. llama.cpp.
2. Pi with extension support.

Recommended llama.cpp server:

```bash
llama-server \
  -m ~/models/FastContext-1.0-4B-RL-GGUF/FastContext-1.0-4B-RL-Q4_K_M.gguf \
  --host 127.0.0.1 \
  --port 8772 \
  -ngl 99 \
  -c 32768 \
  --mlock
```

The default extension config assumes:

```text
baseUrl = http://127.0.0.1:8772/v1
model   = FastContext-1.0-4B-RL-Q4_K_M.gguf
```

## Install

### From GitHub

```bash
pi install git:github.com/Termina1/pi-fastcontext
# or
pi install https://github.com/Termina1/pi-fastcontext
```

### Local development checkout

```bash
cd ~/Work
git clone https://github.com/Termina1/pi-fastcontext.git
pi install ~/Work/pi-fastcontext
```

After install/reload, Pi gets:

- tool: `fast_context_search`
- command: `/fastcontext <query>`

## Configuration

Configuration is resolved in this order; later sources override earlier ones:

1. Built-in defaults
2. User config: `~/.pi/agent/fastcontext.json`
3. Project config: `<repo>/.pi/fastcontext.json`
4. Environment variables
5. Per-tool parameters

Example config file:

```json
{
  "baseUrl": "http://127.0.0.1:8772/v1",
  "model": "FastContext-1.0-4B-RL-Q4_K_M.gguf",
  "maxTurns": 4,
  "maxTokens": 800
}
```

Environment variables:

```bash
export FASTCONTEXT_BASE_URL="http://127.0.0.1:8772/v1"
export FASTCONTEXT_MODEL="FastContext-1.0-4B-RL-Q4_K_M.gguf"
export FASTCONTEXT_MAX_TURNS=4
export FASTCONTEXT_MAX_TOKENS=800
```

## Usage

Ask Pi to use the tool:

```text
Use fast_context_search to find where request auth processors are implemented.
```

Or run the command in interactive Pi:

```text
/fastcontext find where request auth processors are implemented
```

Tool parameters:

```ts
fast_context_search({
  query: "Find where JSON-RPC response caching is implemented",
  cwd: "/path/to/repo",          // optional, defaults to current Pi cwd
  maxTurns: 4,                   // optional, 1..8
  maxTokens: 800,                // optional, 128..4096
  baseUrl: "http://.../v1",     // optional override
  model: "...",                 // optional override
  includeTranscript: false       // optional debug output in details
})
```

## Output

The tool returns:

- `<final_answer>` with compact citations
- validation summary (`valid citations`, `tool calls`, time, tokens)
- warnings if the model failed to close the tag or returned too many citations

Example:

```text
# FastContext Result
<final_answer>
internal/auth/request_auth.go:10-28 — NewAuthRequestStrategy factory
internal/auth/simple_auth_processors.go:34-60 — simpleAuthProcessor methods
</final_answer>
## Validation
- Valid citations: 2/2
- Tool calls: 5 (0 failed)
- Time: 5.5s
```

## When to use

Good fit:

- quick symbol/file localization
- exact `file:line` evidence before planning or editing
- first pass over an unfamiliar code area

Not a full replacement for Pi's `context-builder`:

- deep architecture synthesis
- external research
- implementation plans
- broad product/spec reasoning

Use `fast_context_search` first, then escalate to a normal context builder if the query is broad or the warnings indicate low confidence.

## Development

For local testing without installing:

```bash
pi -e ~/Work/pi-fastcontext -p --no-session \
  --tools fast_context_search \
  "Use fast_context_search to find where auth processors are implemented"
```

To make Pi load the local checkout globally:

```bash
pi install ~/Work/pi-fastcontext
# or edit ~/.pi/agent/settings.json packages manually
```

Reload an existing Pi session with `/reload` after changing the extension.
