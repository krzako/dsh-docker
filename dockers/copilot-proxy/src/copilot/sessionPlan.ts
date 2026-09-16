import crypto from "node:crypto";

import type { CopilotSessionBinding } from "../conversations/types.js";
import { buildCopilotInput, serializeConversation } from "../openai/serializeMessages.js";
import type { ChatCompletionRequest, OpenAIChatMessage } from "../types/openai.js";

export type SessionPlan = {
    resumeId?: string;
    deltaMessages: OpenAIChatMessage[];
    inputHashes: string[];
    configHash: string;
};

function hash(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex");
}

export function messageHashes(messages: OpenAIChatMessage[]): string[] {
    return messages.map((message) => hash(serializeConversation([message])));
}

export function planSession(request: ChatCompletionRequest, binding?: CopilotSessionBinding): SessionPlan {
    const inputHashes = messageHashes(request.messages);
    const { systemMessage } = buildCopilotInput(request);
    const configHash = hash(JSON.stringify({
        model: request.model,
        reasoningEffort: request.reasoning_effort,
        systemMessage,
        tools: request.tool_choice === "none" ? [] : request.tools ?? [],
        toolChoice: request.tool_choice,
    }));
    const canResume = binding?.model === request.model &&
        binding.configHash === configHash &&
        binding.messageHashes.length < inputHashes.length &&
        binding.messageHashes.every((item, index) => item === inputHashes[index]);
    return {
        ...(canResume ? { resumeId: binding.id } : {}),
        deltaMessages: canResume ? request.messages.slice(binding.messageHashes.length) : request.messages,
        inputHashes,
        configHash,
    };
}
