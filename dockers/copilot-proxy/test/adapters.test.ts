import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { toCanonicalRequest } from "../src/conversations/adapters.js";
import { ConversationStore } from "../src/conversations/ConversationStore.js";
import { identifySource, IdentifierConflictError } from "../src/conversations/identifiers.js";
import { buildCopilotInput } from "../src/openai/serializeMessages.js";
import type { ChatCompletionRequest } from "../src/types/openai.js";

function request(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
    return {
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
        ...overrides,
    };
}

function incoming(headers: Record<string, string> = {}) {
    return { headers } as never;
}

test("maps OpenCode session and preserves the transport header separately", () => {
    const result = toCanonicalRequest(
        incoming({ "x-session-id": "header-session", "x-request-id": "req-1" }),
        request({ metadata: { source: "opencode", session_id: "header-session", message_id: "msg-1" } }),
    );
    assert.equal(result.source, "opencode");
    assert.equal(result.requestId, "req-1");
    assert.deepEqual(result.external, {
        opencode_session_id: "header-session",
        opencode_header_session_id: "header-session",
        external_message_id: "msg-1",
    });
});

test("recognizes actual OpenCode session headers", () => {
    const result = toCanonicalRequest(
        incoming({
            "user-agent": "opencode/1.18.29 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14",
            "x-session-id": "ses-1",
            "x-session-affinity": "ses-1",
        }),
        request(),
    );
    assert.equal(result.source, "opencode");
    assert.deepEqual(result.external, {
        opencode_session_id: "ses-1",
        opencode_header_session_id: "ses-1",
        opencode_affinity_session_id: "ses-1",
    });
});

test("rejects conflicting OpenCode identifiers", () => {
    assert.throws(
        () =>
            toCanonicalRequest(
                incoming({ "x-session-id": "header-session" }),
                request({ metadata: { source: "opencode", session_id: "body-session" } }),
            ),
        IdentifierConflictError,
    );
    assert.throws(
        () =>
            toCanonicalRequest(
                incoming(),
                request({ metadata: { source: "opencode", session_id: "body-1", opencode_session_id: "body-2" } }),
            ),
        IdentifierConflictError,
    );
});

test("selects DeepSeek and Open WebUI source identifiers without conflating them", () => {
    const deepseek = toCanonicalRequest(
        incoming(),
        request({ metadata: { conversation_id: "ds-conv", session_id: "ds-session", thread_id: "ds-thread" } }),
    );
    const webui = toCanonicalRequest(incoming(), request({ chat_id: "chat-1", session_id: "web-session" }));
    assert.equal(deepseek.source, "deepseek-harness");
    assert.deepEqual(deepseek.external, {
        deepseek_conversation_id: "ds-conv",
        deepseek_session_id: "ds-session",
        deepseek_thread_id: "ds-thread",
    });

    assert.equal(webui.source, "open-webui");
    assert.deepEqual(webui.external, {
        openwebui_chat_id: "chat-1",
        openwebui_session_id: "web-session",
    });
});

test("does not guess a source when no source identifiers are present", () => {
    assert.equal(identifySource(incoming(), request()), undefined);
});

test("recognizes Open WebUI backend requests by its aiohttp user agent", () => {
    assert.equal(
        identifySource(incoming({ "user-agent": "Python/3.11 aiohttp/3.13.5" }), request()),
        "open-webui",
    );
});

test("keeps tool calls and tool results in the serialized conversation", () => {
    const result = buildCopilotInput(
        request({
            messages: [
                { role: "user", content: "read it" },
                {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                        {
                            id: "call-1",
                            type: "function",
                            function: { name: "read_file", arguments: '{"path":"README.md"}' },
                        },
                    ],
                },
                { role: "tool", tool_call_id: "call-1", content: "contents" },
            ],
        }),
    );
    assert.match(result.prompt, /"tool_calls"/);
    assert.match(result.prompt, /"tool_call_id":"call-1"/);
});

test("resolves one durable conversation for concurrent retries", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "copilot-proxy-"));
    const store = new ConversationStore(path.join(directory, "state.json"));
    const external = { deepseek_conversation_id: "ds-1" };
    const ids = await Promise.all([
        store.resolve("deepseek-harness", "user-1", external, undefined),
        store.resolve("deepseek-harness", "user-1", external, undefined),
    ]);
    assert.equal(ids[0], ids[1]);
    await store.recordRequest({
        requestId: "req-1",
        source: "deepseek-harness",
        userId: "user-1",
        conversationId: ids[0]!,
        external,
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
        metadata: {},
    });
    await store.completeRequest("req-1", "completed");
    const persisted = JSON.parse(await readFile(path.join(directory, "state.json"), "utf8")) as {
        conversations: unknown[];
        requests: Record<string, { status: string }>;
    };
    assert.equal(persisted.conversations.length, 1);
    assert.equal(persisted.requests["req-1"]?.status, "completed");
});

test("deduplicates a repeated external message id", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "copilot-proxy-"));
    const store = new ConversationStore(path.join(directory, "state.json"));
    const conversationId = await store.resolve(
        "open-webui",
        "user-1",
        { openwebui_chat_id: "chat-1", external_message_id: "msg-1" },
        undefined,
        "req-1",
    );
    const canonical = {
        requestId: "req-1",
        source: "open-webui" as const,
        userId: "user-1",
        conversationId,
        external: { openwebui_chat_id: "chat-1", external_message_id: "msg-1" },
        model: "test-model",
        messages: [{ role: "user" as const, content: "hello" }],
        stream: false,
        metadata: {},
    };
    assert.equal(await store.recordRequest(canonical), "new");
    assert.equal(await store.recordRequest({ ...canonical, requestId: "req-2" }), "duplicate");
});
