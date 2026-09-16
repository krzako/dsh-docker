import assert from "node:assert/strict";
import test from "node:test";

import { messageHashes, planSession } from "../src/copilot/sessionPlan.js";
import type { CopilotSessionBinding } from "../src/conversations/types.js";
import type { ChatCompletionRequest } from "../src/types/openai.js";

const first: ChatCompletionRequest = {
    model: "gpt-5.6-luna",
    messages: [{ role: "user", content: "first" }],
};

function binding(request: ChatCompletionRequest): CopilotSessionBinding {
    return {
        id: "sdk-session",
        model: request.model,
        configHash: planSession(request).configHash,
        messageHashes: messageHashes([...request.messages, { role: "assistant", content: "answer" }]),
        lastUsedAt: new Date().toISOString(),
    };
}

test("resumes only the new messages after a matching history prefix", () => {
    const next: ChatCompletionRequest = {
        ...first,
        messages: [...first.messages, { role: "assistant", content: "answer" }, { role: "user", content: "next" }],
    };
    const plan = planSession(next, binding(first));
    assert.equal(plan.resumeId, "sdk-session");
    assert.deepEqual(plan.deltaMessages, [{ role: "user", content: "next" }]);
});

test("starts fresh after history or session configuration changes", () => {
    const old = binding(first);
    for (const request of [
        { ...first, messages: [{ role: "user" as const, content: "edited" }] },
        { ...first, model: "gpt-5.6-terra" },
        { ...first, reasoning_effort: "high" as const },
        { ...first, tools: [{ type: "function" as const, function: { name: "lookup" } }] },
    ]) {
        const plan = planSession(request, old);
        assert.equal(plan.resumeId, undefined);
        assert.deepEqual(plan.deltaMessages, request.messages);
    }
});

test("reasoning summary metadata does not break the client history prefix", () => {
    const history = [
        ...first.messages,
        { role: "assistant" as const, content: "answer", reasoning_content: "summary" },
    ];
    assert.deepEqual(messageHashes(history), binding(first).messageHashes);
});
