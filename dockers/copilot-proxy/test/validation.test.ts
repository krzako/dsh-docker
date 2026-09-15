import assert from "node:assert/strict";
import test from "node:test";

import { BadRequestError, parseChatCompletionRequest } from "../src/openai/validation.js";

function request(reasoningEffort?: string) {
    return {
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
        ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
    };
}

test("leaves omitted and default reasoning effort unset", () => {
    assert.equal(parseChatCompletionRequest(request()).reasoning_effort, undefined);
    assert.equal(parseChatCompletionRequest(request("default")).reasoning_effort, undefined);
});

test("normalizes off and accepts current Copilot runtime reasoning levels", () => {
    assert.equal(parseChatCompletionRequest(request("off")).reasoning_effort, "none");
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
        assert.equal(parseChatCompletionRequest(request(effort)).reasoning_effort, effort);
    }
});

test("rejects unknown reasoning effort", () => {
    assert.throws(() => parseChatCompletionRequest(request("extreme")), BadRequestError);
});
