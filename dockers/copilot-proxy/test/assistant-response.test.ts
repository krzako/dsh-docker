import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEvent } from "@github/copilot-sdk";

import { AssistantResponse } from "../src/copilot/AssistantResponse.js";

function event(type: string, data: Record<string, unknown>): SessionEvent {
    return { type, data } as SessionEvent;
}

test("starts streaming content at the first text delta without waiting for complete reasoning", () => {
    const output: string[] = [];
    const response = new AssistantResponse(
        {
            onReasoningDelta: (text) => output.push(`reasoning:${text}`),
            onTextDelta: (text) => output.push(`content:${text}`),
        },
    );

    response.accept(event("assistant.reasoning_delta", { reasoningId: "r1", deltaContent: "think " }));
    response.accept(event("assistant.reasoning_delta", { reasoningId: "r1", deltaContent: "first" }));
    response.accept(event("assistant.message_delta", { messageId: "m1", deltaContent: "answer " }));
    response.accept(event("assistant.message_delta", { messageId: "m1", deltaContent: "now" }));
    // The SDK can publish this complete event only after message deltas.
    response.accept(event("assistant.reasoning", { reasoningId: "r1", content: "think first" }));

    assert.deepEqual(output, [
        "reasoning:think ",
        "reasoning:first",
        "content:answer ",
        "content:now",
    ]);
    assert.equal(response.reasoningContent, "think first");
    assert.equal(response.content, "answer now");
});

test("does not emit a late reasoning fallback after streamed content", () => {
    const output: string[] = [];
    const response = new AssistantResponse(
        {
            onReasoningDelta: (text) => output.push(`reasoning:${text}`),
            onTextDelta: (text) => output.push(`content:${text}`),
        },
    );

    response.accept(event("assistant.message_delta", { messageId: "m1", deltaContent: "answer" }));
    response.accept(event("assistant.message", {
        messageId: "m1",
        reasoningText: "late summary",
        content: "answer",
    }));

    assert.deepEqual(output, ["content:answer"]);
    assert.equal(response.reasoningContent, "late summary");
});

test("uses complete-message reasoning and content when deltas are absent", () => {
    const output: string[] = [];
    const response = new AssistantResponse(
        {
            onReasoningDelta: (text) => output.push(`reasoning:${text}`),
            onTextDelta: (text) => output.push(`content:${text}`),
        },
    );

    response.accept(event("assistant.message", {
        messageId: "m1",
        reasoningText: "private summary",
        content: "public answer",
    }));

    assert.deepEqual(output, ["reasoning:private summary", "content:public answer"]);
    assert.equal(response.reasoningContent, "private summary");
    assert.equal(response.content, "public answer");
});

test("does not duplicate complete events after streaming deltas", () => {
    const output: string[] = [];
    const response = new AssistantResponse(
        {
            onReasoningDelta: (text) => output.push(`reasoning:${text}`),
            onTextDelta: (text) => output.push(`content:${text}`),
        },
    );

    response.accept(event("assistant.reasoning_delta", { reasoningId: "r1", deltaContent: "think" }));
    response.accept(event("assistant.reasoning", { reasoningId: "r1", content: "think" }));
    response.accept(event("assistant.message_delta", { messageId: "m1", deltaContent: "answer" }));
    response.accept(event("assistant.message", {
        messageId: "m1",
        reasoningText: "think",
        content: "answer",
    }));

    assert.deepEqual(output, ["reasoning:think", "content:answer"]);
    assert.equal(response.reasoningContent, "think");
    assert.equal(response.content, "answer");
});

test("streams ordinary content immediately when reasoning was not requested", () => {
    const output: string[] = [];
    const response = new AssistantResponse({ onTextDelta: (text) => output.push(text) });

    response.accept(event("assistant.message_delta", { messageId: "m1", deltaContent: "hello" }));

    assert.deepEqual(output, ["hello"]);
});
