import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CopilotGateway, type CopilotCompletion } from "../src/copilot/CopilotGateway.js";
import { CopilotSessionManager, SESSION_RETENTION_MS } from "../src/copilot/CopilotSessionManager.js";
import type { SessionPlan } from "../src/copilot/sessionPlan.js";
import { ConversationStore } from "../src/conversations/ConversationStore.js";
import type { ChatCompletionRequest } from "../src/types/openai.js";

function completion(sessionId: string, resumed: boolean): CopilotCompletion {
    return {
        sessionId, resumed, content: "answer", reasoningContent: "",
        toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
        finishReason: "stop",
    };
}

test("persists one SDK session and resumes it on the next turn", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "copilot-proxy-session-"));
    const store = new ConversationStore(path.join(directory, "state.json"));
    const conversationId = await store.resolve("deepseek-harness", undefined, { deepseek_session_id: "dsh-1" }, undefined);
    const plans: SessionPlan[] = [];
    const gateway = {
        complete: async (_request: ChatCompletionRequest, _callbacks: unknown, _signal: unknown, plan: SessionPlan) => {
            plans.push(plan);
            return completion(plan.resumeId ?? "sdk-1", Boolean(plan.resumeId));
        },
    } as unknown as CopilotGateway;
    const manager = new CopilotSessionManager(gateway, store);
    const first: ChatCompletionRequest = { model: "gpt-5.6-luna", messages: [{ role: "user", content: "first" }] };
    await manager.complete(conversationId, first);
    const next: ChatCompletionRequest = {
        ...first,
        messages: [...first.messages, { role: "assistant", content: "answer" }, { role: "user", content: "next" }],
    };
    await manager.complete(conversationId, next);
    assert.equal(plans[0]?.resumeId, undefined);
    assert.equal(plans[1]?.resumeId, "sdk-1");
    assert.deepEqual(plans[1]?.deltaMessages, [{ role: "user", content: "next" }]);
    assert.equal((await store.getCopilotSession(conversationId))?.id, "sdk-1");
});

test("serializes concurrent turns for one chat but allows another chat to proceed", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "copilot-proxy-session-"));
    const store = new ConversationStore(path.join(directory, "state.json"));
    const a = await store.resolve("open-webui", undefined, { openwebui_chat_id: "a" }, undefined);
    const b = await store.resolve("open-webui", undefined, { openwebui_chat_id: "b" }, undefined);
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let count = 0;
    const gateway = {
        complete: async () => {
            const index = ++count;
            events.push(`start-${index}`);
            if (index === 1) await firstGate;
            events.push(`end-${index}`);
            return completion(`sdk-${index}`, false);
        },
        deleteSession: async () => undefined,
    } as unknown as CopilotGateway;
    const manager = new CopilotSessionManager(gateway, store);
    const request: ChatCompletionRequest = { model: "gpt-5.6-luna", messages: [{ role: "user", content: "hello" }] };
    const first = manager.complete(a, request);
    const second = manager.complete(a, request);
    const independent = manager.complete(b, request);
    await independent;
    assert.deepEqual(events.slice(0, 3), ["start-1", "start-2", "end-2"]);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(events.slice(-2), ["start-3", "end-3"]);
});

test("invalidates a failed SDK session and starts fresh on the next turn", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "copilot-proxy-session-"));
    const store = new ConversationStore(path.join(directory, "state.json"));
    const conversationId = await store.resolve("opencode", undefined, { opencode_session_id: "oc-1" }, undefined);
    let calls = 0;
    const deleted: string[] = [];
    const gateway = {
        complete: async () => {
            calls += 1;
            if (calls === 2) throw new Error("runtime failure");
            return completion(`sdk-${calls}`, false);
        },
        deleteSession: async (id: string) => { deleted.push(id); },
    } as unknown as CopilotGateway;
    const manager = new CopilotSessionManager(gateway, store);
    const request: ChatCompletionRequest = { model: "gpt-5.6-luna", messages: [{ role: "user", content: "hello" }] };
    await manager.complete(conversationId, request);
    await assert.rejects(() => manager.complete(conversationId, request), /runtime failure/);
    assert.equal(await store.getCopilotSession(conversationId), undefined);
    await manager.flushPendingDeletes();
    assert.deepEqual(deleted, ["sdk-1"]);
    await manager.complete(conversationId, request);
    assert.equal((await store.getCopilotSession(conversationId))?.id, "sdk-3");
});

test("retains active sessions and deletes idle sessions after fourteen days", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "copilot-proxy-session-"));
    const store = new ConversationStore(path.join(directory, "state.json"));
    const oldId = await store.resolve("deepseek-harness", undefined, { deepseek_session_id: "old" }, undefined);
    const activeId = await store.resolve("deepseek-harness", undefined, { deepseek_session_id: "active" }, undefined);
    const now = new Date("2026-09-16T00:00:00.000Z");
    for (const conversationId of [oldId, activeId]) {
        await store.setCopilotSession(conversationId, {
            id: `sdk-${conversationId}`,
            model: "gpt-5.6-luna",
            configHash: "hash",
            messageHashes: [],
            lastUsedAt: new Date(now.getTime() - SESSION_RETENTION_MS - 1).toISOString(),
        });
    }
    const deleted: string[] = [];
    const gateway = { deleteSession: async (id: string) => { deleted.push(id); } } as unknown as CopilotGateway;
    const manager = new CopilotSessionManager(gateway, store);
    manager.activeConversationIds.add(activeId);
    await manager.pruneExpired(now);
    assert.deepEqual(deleted, [`sdk-${oldId}`]);
    assert.ok(await store.getCopilotSession(activeId));
    manager.activeConversationIds.delete(activeId);
    await manager.pruneExpired(now);
    assert.deepEqual(deleted, [`sdk-${oldId}`, `sdk-${activeId}`]);
    assert.deepEqual(await store.pendingSessionDeletes(), []);
});

test("retries SDK deletion after a transient cleanup failure", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "copilot-proxy-session-"));
    const store = new ConversationStore(path.join(directory, "state.json"));
    const conversationId = await store.resolve("opencode", undefined, { opencode_session_id: "old" }, undefined);
    await store.setCopilotSession(conversationId, {
        id: "sdk-old", model: "gpt-5.6-luna", configHash: "config", messageHashes: [],
        lastUsedAt: "2026-08-01T00:00:00.000Z",
    });
    let attempts = 0;
    const gateway = {
        deleteSession: async () => {
            attempts += 1;
            if (attempts === 1) throw new Error("transient runtime error");
        },
    } as unknown as CopilotGateway;
    const manager = new CopilotSessionManager(gateway, store);
    await manager.pruneExpired(new Date("2026-09-16T00:00:00.000Z"));
    assert.deepEqual(await store.pendingSessionDeletes(), ["sdk-old"]);
    await manager.flushPendingDeletes();
    assert.deepEqual(await store.pendingSessionDeletes(), []);
    assert.equal(attempts, 2);
});
