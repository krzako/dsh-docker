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
- canonical conversation mapping for OpenCode, DeepSeek Harness and Open WebUI
- durable request/conversation state in `COPILOT_PROXY_CONVERSATION_STORE`

The proxy deliberately runs the SDK in `mode: "empty"` and exposes only tools declared by the API caller. It does not give the model Copilot CLI filesystem/shell tools, MCP servers, skills, memory or repository access.

## Important compatibility note

Copilot SDK is an agent/session API rather than a raw OpenAI Chat Completions endpoint. The proxy therefore serializes the supplied OpenAI conversation history into a stable transcript for each request. This keeps the HTTP interface OpenAI-compatible and lets ordinary OpenAI clients work, but it is not byte-for-byte equivalent to calling OpenAI's API directly.

## Client identity and conversation history

The proxy currently exposes one normalized input endpoint, `POST /v1/chat/completions`.
The source adapter selects the client from `x-proxy-source` or the identifiers below.
OpenCode native URL routing is not implemented; use `x-proxy-source: opencode` when
the URL does not carry a session identifier.

| Source | Main conversation ID | Auxiliary IDs | Message ID |
|---|---|---|---|
| OpenCode | `session_id` / `x-session-id` | `x-session-affinity` | `message_id` |
| DeepSeek Harness | `conversation_id`, `session_id`, `thread_id` | `run_id`, `request_id` | `message_id` |
| Open WebUI | `chat_id` | `session_id` | `message_id` |
| Proxy | `conversation_id` | external IDs | generated request/message records |

Identifiers can be supplied as top-level fields or inside `metadata`. The proxy keeps
`request_id`, `run_id`, `message_id`, `chat_id` and `session_id` distinct. An OpenCode
session/header mismatch returns HTTP 409. Without a stable external ID, a new proxy
conversation is intentionally created; callers should send `x-request-id` to make
retries idempotent. The optional `x-user-id` or `user` value isolates mappings.
If no source can be identified, the proxy does not call Copilot and returns an
OpenAI-compatible assistant response containing `Copilot Proxy: Unable to recognize source`.
Open WebUI requests without an explicit chat/session identifier are recognized by
the observed backend marker `Python/... aiohttp/...`; explicit source and ID fields
always take precedence.

The durable JSON store defaults to `/home/node/.copilot/proxy-conversations.json` and
can be changed with `COPILOT_PROXY_CONVERSATION_STORE`. Incoming ordered `messages` are the
request context and are recorded once per request. The assistant message is appended
only after Copilot completes successfully. Tool calls and tool results remain
structured OpenAI messages; they are not converted to ordinary text.
`COPILOT_PROXY_MAX_CONTEXT_MESSAGES` (default `2000`) rejects oversized contexts rather than
silently dropping messages. Retries with the same `x-request-id` or `message_id` are
deduplicated.

## Streaming and Copilot boundary

The Copilot-specific adapter is `src/copilot/CopilotGateway.ts`. It uses the installed
`@github/copilot-sdk` runtime (`CopilotClient`, `createSession`, `session.send`, and
session events); no undocumented Copilot HTTP protocol or client conversation IDs are
sent upstream. The proxy emits OpenAI-compatible SSE chunks because the SDK event
stream is not OpenAI SSE. It preserves delta order, sends a final `finish_reason`,
optionally sends usage, then `[DONE]`. Client disconnects abort the Copilot session
and mark the request `interrupted`.

Tool calls are intentionally *delegated* to the OpenAI client: a Copilot custom tool handler records the requested function call and immediately aborts that Copilot turn without executing the real tool. The caller (DSH, another agent harness, etc.) executes it and sends the tool result in the next Chat Completions request. This avoids giving Copilot access to the harness's actual tools.

## Requirements

- Node.js 24+
- A GitHub account with Copilot entitlement and access to the requested model

Pinned at creation time:

- `@github/copilot-sdk` 1.0.8
- `@github/copilot` 1.0.80

The proxy connects to a `copilot --headless` runtime over TCP on `127.0.0.1:4321` (hardcoded). In Docker that runtime runs in the same container, so the CLI package ships in the image.

## Install

```bash
npm install
```

### Authentication

The proxy does not read or copy OAuth credentials itself. It only talks to the headless runtime, which owns the login.

Local development: run the already-authenticated CLI in a separate terminal, then start the proxy:

```powershell
copilot --headless --port 4321
```

```powershell
npm run dev
```

First-time CLI login is done once with `copilot login --host company.ghe.com --web-flow`. In Docker see [Docker Compose](#docker-compose).

A local `.env` is already included with `COPILOT_PROXY_PORT=9091` and an example proxy API key. The project automatically loads `.env` via `dotenv/config` for both `npm run dev` and `npm start`.

Default endpoint:

```text
http://127.0.0.1:9090/v1
```

## Check models

```bash
curl http://127.0.0.1:9090/v1/models
```

The response uses normal OpenAI model objects and adds a `copilot` field containing the model capabilities, policy and live billing data returned by GitHub.

## Check quota

```bash
curl http://127.0.0.1:9090/v1/copilot/quota
```

## Chat example

```bash
curl http://127.0.0.1:9090/v1/chat/completions \
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
curl -N http://127.0.0.1:9090/v1/chat/completions \
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
      baseURL: http://host.docker.internal:9090/v1
      apiKeyEnv: COPILOT_PROXY_API_KEY
      models:
        - id: gpt-5.6-sol
        - id: claude-sonnet-5
```

If DSH and this proxy are in the same Compose network, use the service name instead:

```yaml
baseURL: http://copilot-proxy:9090/v1
```

If you leave `COPILOT_PROXY_API_KEY` empty, the proxy does not require an Authorization header. If your client insists on an API key, give it any value only when the proxy itself has no key configured.

## Docker Compose

```bash
docker compose up -d --build
```

The container first runs `copilot login --host <COPILOT_PROXY_GHE_HOST> --device-code`, then starts the proxy in the background (`nohup`, log at `/app/logs/copilot-proxy/proxy.log`, port `9090`) and `copilot --headless --host 127.0.0.1 --port 4321` as its main process. Runtime logs are written to `/app/logs/copilot-proxy/headless.log`.

### Authentication (device code)

The login prints the device code and URL to the container logs:

```bash
docker logs -f copilot-proxy
```

```text
To authenticate, visit https://company.ghe.com/login/device and enter code XXXX-XXXX
Waiting for authorization...
```

Open the URL in a browser (any machine) and enter the code — there is no local OAuth callback, so it works from the Docker host. The CLI polls for the result; once authorized, the proxy and headless runtime come up.

The device code flow is used on purpose: the web flow (`--web-flow`) redirects the browser to `http://127.0.0.1:<port>/callback` inside the container, which a host browser cannot reach.

### Where the token is stored

The token is stored in `/home/node/.copilot/config.json` (key `copilotTokens`, file mode `600`) inside the **named volume** `copilot-proxy-data` (created as `openwebui_copilot-proxy-data` by this compose project), so it survives container restarts and recreation. A named volume is used instead of a Windows bind mount for speed and reliability.

Two things make this work:

- `COPILOT_HOME=/home/node/.copilot` (and `HOME=/home/node`) is pinned in the image `ENV`. Docker Desktop can forward host environment variables (e.g. a Windows `HOME`) into containers; without the pin the CLI would use a non-persistent `~/.copilot` and the token would be lost on every restart.
- The entrypoint keeps `"storeTokenPlaintext": true` set (the CLI's built-in switch for non-interactive plaintext token storage; the interactive alternative asks "Store token in plaintext config file?" and requires a TTY). The runtime migrates the key from `config.json` to `settings.json` on startup, so the entrypoint only re-adds it when missing.


If login was not completed, re-run it any time:

```bash
docker exec -it copilot-proxy sh -c 'copilot login --host "$COPILOT_PROXY_GHE_HOST" --device-code'
```

The entrypoint skips the login entirely when a valid token is already present (`Already authenticated.` in the logs). Until login completes, API calls return `Not authenticated`.

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

Set `COPILOT_PROXY_API_KEY` if anything other than localhost can reach the proxy:

```bash
COPILOT_PROXY_API_KEY=replace-with-a-long-random-value
```

Then callers must send:

```text
Authorization: Bearer replace-with-a-long-random-value
```

Do not expose the proxy publicly without authentication. Whoever can reach it can consume the authenticated GitHub Copilot account's quota/AI credits.

## Proxy logging

Proxy logging is controlled independently from the Copilot SDK logging:

```env
COPILOT_PROXY_LOG_LEVEL=debug
COPILOT_PROXY_LOG_REQUESTS=true
```

The current Docker Compose defaults enable request logging. The mounted host directory
is `./volumes/copilot-proxy-logs/`. It contains:

```text
volumes/copilot-proxy-logs/
  copilot-proxy.log
  opencode/
  deepseek-harness/
  open-webui/
  unknown/
```

Each captured request gets four JSON files in its adapter directory:

```text
<timestamp>_input_headers.json
<timestamp>_input_body.json
<timestamp>_output_headers.json
<timestamp>_output_body.json
```

Authorization, cookie and proxy-authorization headers are replaced with `[REDACTED]`.
Request bodies are intentionally captured when `COPILOT_PROXY_LOG_REQUESTS=true`, so disable
that switch in production if prompts or responses must not be persisted.

`COPILOT_PROXY_COPILOT_SDK_LOG_LEVEL` controls only the log level passed to the
GitHub Copilot SDK. `COPILOT_PROXY_LOG_LEVEL` controls the proxy's own
`copilot-proxy.log`.
