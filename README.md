# pi-fastcontext

Pi extension for fast, local, read-only repository search with Qwen3.8 Flash. It exposes one Pi tool, `fast_context_search`, which runs a bounded model loop over three repository operations:

- `GLOB(pattern)`
- `GREP(pattern, path?)`
- `READ(path, offset?, limit?)`

The package name and public tool name are retained for existing Pi installations. The implementation no longer uses Microsoft FastContext or its SWE-bench path conventions.

## Defaults

```text
base URL     http://127.0.0.1:8770/v1
model        qwen38-flash-next-q4-nothink-p1
tool turns   3
max tokens   512
thinking     disabled in every request
citations    at most 5
```

These defaults target Qwen3.8-Flash-Next UD-Q4_K_XL served by a qwen4exp-capable llama.cpp build.

## Server

The extension does not start or manage the model server. A compatible launch looks like:

```bash
llama-server \
  --model /path/to/Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004.gguf \
  --alias qwen38-flash-next-q4-nothink-p1 \
  --host 127.0.0.1 --port 8770 \
  --ctx-size 32768 --parallel 1 \
  --n-gpu-layers 999 --flash-attn on \
  --cache-type-k q8_0 --cache-type-v q8_0 \
  --batch-size 512 --ubatch-size 512 \
  --jinja --reasoning off \
  --chat-template-kwargs '{"enable_thinking":false}'
```

Qwen3.8-Flash-Next uses the experimental `qwen4exp` architecture. Use a llama.cpp revision that supports it.

## Installation

```bash
pi install git:github.com/Termina1/pi-fastcontext
```

For this checkout:

```bash
pi install ~/Work/pi-fastcontext
```

Reload an existing Pi session with `/reload`.

## Usage

Ask Pi to use the tool:

```text
Use fast_context_search to locate request authentication and return file:line evidence.
```

Or invoke the command:

```text
/fastcontext locate request authentication
```

The public tool accepts a query, an optional repository root, and an optional transcript flag:

```ts
fast_context_search({
  query: "Where is JSON-RPC caching implemented?",
  cwd: "/path/to/repository", // current Pi cwd when omitted
  includeTranscript: false
})
```

When `cwd` is provided, the search runs in that directory. The model endpoint and search budget remain user configuration rather than tool arguments.

## Configuration

Configuration precedence, from lowest to highest:

1. built-in defaults
2. `~/.pi/agent/fastcontext.json`
3. `<repo>/.pi/fastcontext.json`, only for trusted projects
4. environment variables

Model calls cannot override the model endpoint or search budget.

Example:

```json
{
  "baseUrl": "http://127.0.0.1:8770/v1",
  "model": "qwen38-flash-next-q4-nothink-p1",
  "maxTurns": 3,
  "maxTokens": 512
}
```

Environment variables remain:

```bash
FASTCONTEXT_BASE_URL=http://127.0.0.1:8770/v1
FASTCONTEXT_MODEL=qwen38-flash-next-q4-nothink-p1
FASTCONTEXT_MAX_TURNS=3
FASTCONTEXT_MAX_TOKENS=512
```

## Security and protocol

- The endpoint must be an HTTP loopback URL; repository evidence is never sent to a remote host.
- The search root is the requested `cwd`, or the current Pi session directory when omitted.
- Paths must be relative to the repository root.
- Absolute paths and `..` traversal are rejected rather than corrected.
- Symlinks are ignored during discovery and rejected when addressed directly.
- Binary, unsupported, and files larger than 2 MB are not read.
- Common generated/vendor directories are skipped.
- GREP runs through ripgrep's linear-time regex engine with a 5-second deadline.
- Multiple sibling model tool calls execute concurrently.
- Returned citations are checked against real files and line bounds.
- Invalid citation lines are removed.

## Output

```text
# FastContext Result

<final_answer>
src/auth/request.ts:18-34 — request authentication entry point
src/auth/session.ts:55-71 — session validation
</final_answer>

## Validation
- Valid citations: 2
- Tool calls: 4 (0 failed)
- Model passes: 4
- Time: 24.8s
- Tokens: prompt 10264, completion 327, cached 4200
```

Nested model usage is attached to the Pi tool result, so it is included in session usage accounting.

## Development

```bash
npm install
npm run check
npm test
```

Run the local extension without installing it:

```bash
pi -e ~/Work/pi-fastcontext -p --no-session \
  --tools fast_context_search \
  "Use fast_context_search to locate the repository search loop."
```
