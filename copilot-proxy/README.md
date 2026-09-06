# Copilot OpenAI Proxy

OpenAI-compatible HTTP proxy backed by the official GitHub Copilot SDK.

It is intended for clients that can speak the OpenAI Chat Completions protocol (for example DSH configured with an `openai-completions` provider), while authentication, model entitlement, prompt caching and billing happen through GitHub Copilot.

## What is implemented

- `GET /health`
- `GET /v1/models`
- `GET /v1/copilot/quota` (non-OpenAI extension)
- `POST /v1/chat/completions`
- non-streaming responses
- SSE streaming (`stream: true`)
- `stream_options.include_usage`
- OpenAI function tools -> Copilot SDK custom tools -> OpenAI `tool_calls`
- `system` and `developer` messages
- `reasoning_effort`: `low`, `medium`, `high`, `xhigh`
- `response_format` as prompt-level guidance
- usage extensions for cache reads/writes and Copilot AI credits

The proxy deliberately runs the SDK in `mode: "empty"` and exposes only tools declared by the API caller. It does not give the model Copilot CLI filesystem/shell tools, MCP servers, skills, memory or repository access.

## Important compatibility note

Copilot SDK is an agent/session API rather than a raw OpenAI Chat Completions endpoint. The proxy therefore serializes the supplied OpenAI conversation history into a stable transcript for each request. This keeps the HTTP interface OpenAI-compatible and lets ordinary OpenAI clients work, but it is not byte-for-byte equivalent to calling OpenAI's API directly.

Tool calls are intentionally *delegated* to the OpenAI client: a Copilot custom tool handler records the requested function call and immediately aborts that Copilot turn without executing the real tool. The caller (DSH, another agent harness, etc.) executes it and sends the tool result in the next Chat Completions request. This avoids giving Copilot access to the harness's actual tools.

## Requirements

- Node.js 24+
- A GitHub account with Copilot entitlement and access to the requested model

Pinned at creation time:

- `@github/copilot-sdk` 1.0.8
- `@github/copilot` 1.0.80

The SDK currently bundles the Copilot runtime, so the CLI package is not required for inference itself. It is included as a development dependency only for a convenient local interactive login path and is pruned from the production Docker image.

## Install

```bash
npm install
```

### Authentication option A: existing Copilot login via headless runtime (recommended locally)

If `copilot -p "test"` already works under your Windows user, start that authenticated CLI as a headless runtime in a separate terminal:

```powershell
copilot --headless --port 4321
```

Then set:

```env
COPILOT_RUNTIME_URL=localhost:4321
```

The proxy connects with `RuntimeConnection.forUri(...)`. The external Copilot CLI owns authentication; the proxy does not try to read or copy OAuth credentials itself.

The included `.env.example` enables this local flow by default.

### Authentication option B: token / SDK-managed runtime

Clear `COPILOT_RUNTIME_URL`, then set a fine-grained GitHub PAT with the **Copilot Requests** permission. GitHub recommends `COPILOT_GITHUB_TOKEN` for explicit Copilot usage:

```bash
export COPILOT_GITHUB_TOKEN=github_pat_...
```

On PowerShell:

```powershell
$env:COPILOT_GITHUB_TOKEN = "github_pat_..."
```

`GITHUB_TOKEN` is also accepted as a fallback.

For a server/container this is usually easier than interactive login.

## Run

For the already-authenticated local CLI flow, use two terminals.

Terminal 1:

```powershell
copilot --headless --port 4321
```

Terminal 2:

```powershell
npm install
npm run dev
```

A local `.env` is already included with `PORT=9999`, no proxy API key, and `COPILOT_RUNTIME_URL=localhost:4321`.

Then test:

```powershell
curl.exe http://127.0.0.1:9999/v1/models
```

Or simply run:

```bash
npm run dev
```

or:

```bash
npm run build
npm start
```

Default endpoint:

```text
http://127.0.0.1:9999/v1
```

The project automatically loads `.env` via `dotenv/config` for both `npm run dev` and `npm start`.

## Check models

```bash
curl http://127.0.0.1:9999/v1/models
```

The response uses normal OpenAI model objects and adds a `copilot` field containing the model capabilities, policy and live billing data returned by GitHub.

## Check quota

```bash
curl http://127.0.0.1:9999/v1/copilot/quota
```

## Chat example

```bash
curl http://127.0.0.1:9999/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.6-sol",
    "messages": [
      {"role": "user", "content": "Napisz hello w TypeScript"}
    ]
  }'
```

## Streaming

```bash
curl -N http://127.0.0.1:9999/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.6-sol",
    "stream": true,
    "stream_options": {"include_usage": true},
    "messages": [
      {"role": "user", "content": "Wyjaśnij MVCC w PostgreSQL"}
    ]
  }'
```

The final usage chunk includes normal OpenAI fields plus:

```json
{
  "copilot_usage": {
    "total_nano_aiu": 123000000,
    "ai_credits": 0.123,
    "premium_request_cost": 0,
    "cache_read_tokens": 95000,
    "cache_write_tokens": 0,
    "actual_model": "..."
  }
}
```

`prompt_tokens_details.cached_tokens` also contains Copilot's `cacheReadTokens`. `ai_credits` is exposed as a convenience conversion from the SDK's `totalNanoAiu / 1e9`; GitHub's own quota/billing data remains the source of truth.

## DSH example

Use the proxy as an OpenAI-completions provider. The exact surrounding DSH YAML depends on your config, but the relevant part is:

```yaml
llm-pi-ai:
  providers:
    github-copilot-proxy:
      displayName: GitHub Copilot Proxy
      api: openai-completions
      baseURL: http://host.docker.internal:9999/v1
      apiKeyEnv: COPILOT_PROXY_API_KEY
      models:
        - id: gpt-5.6-sol
        - id: claude-sonnet-5
```

If DSH and this proxy are in the same Compose network, use the service name instead:

```yaml
baseURL: http://copilot-openai-proxy:9999/v1
```

If you leave `PROXY_API_KEY` empty, the proxy does not require an Authorization header. If your client insists on an API key, give it any value only when the proxy itself has no key configured.

## Docker Compose

Create `.env` from `.env.example`. The supplied compose file binds the proxy only to `127.0.0.1:9999` on the host.

If the proxy itself runs in Docker but the authenticated Copilot CLI runs on the Windows host, the CLI must listen beyond loopback:

```powershell
copilot --headless --host 0.0.0.0 --port 4321
```

and set in `.env`:

```env
COPILOT_RUNTIME_URL=host.docker.internal:4321
```

Then:

```bash
docker compose up -d --build
```

Alternatively, omit `COPILOT_RUNTIME_URL` and provide `COPILOT_GITHUB_TOKEN` to let the SDK spawn its own runtime inside the container.

## Tool calling

Example request:

```json
{
  "model": "gpt-5.6-sol",
  "messages": [{"role": "user", "content": "Sprawdź pogodę w Poznaniu"}],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get weather for a city",
        "parameters": {
          "type": "object",
          "properties": {"city": {"type": "string"}},
          "required": ["city"]
        }
      }
    }
  ]
}
```

A tool request comes back as ordinary OpenAI `message.tool_calls`. The proxy does **not** execute `get_weather`; the OpenAI client/harness should execute it and send a `role: "tool"` result in the next request.

Current implementation aborts the Copilot turn after the first delegated function call has been captured. This is intentional for agent-harness compatibility and means parallel tool calls are effectively serialized even if the incoming request sets `parallel_tool_calls: true`.

## Reasoning effort

The proxy passes `reasoning_effort` through to the SDK. Model support is provider/model dependent, so first inspect `GET /v1/models` and use `copilot.supported_reasoning_efforts` instead of assuming every model accepts every level.

## Unsupported / approximate OpenAI parameters

The Copilot SDK does not expose every raw inference parameter that OpenAI Chat Completions exposes. In particular, this proxy currently does not enforce `temperature`, `top_p`, `max_tokens`, `max_completion_tokens` or `stop`. They are accepted for compatibility but not forwarded as raw provider parameters.

`response_format` is implemented as an explicit system instruction because the Copilot SDK session API does not expose the OpenAI Chat Completions `response_format` object directly.

Images represented by `image_url` parts are currently serialized as URL text rather than attached as native Copilot image attachments. Text and tool-based coding harness traffic is the target use case for this version.

## Security

Set `PROXY_API_KEY` if anything other than localhost can reach the proxy:

```bash
PROXY_API_KEY=replace-with-a-long-random-value
```

Then callers must send:

```text
Authorization: Bearer replace-with-a-long-random-value
```

Do not expose the proxy publicly without authentication. Whoever can reach it can consume the authenticated GitHub Copilot account's quota/AI credits.
