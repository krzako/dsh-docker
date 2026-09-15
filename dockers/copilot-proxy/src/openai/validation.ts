import type {
    ChatCompletionRequest,
    OpenAIChatMessage,
    OpenAIFunctionTool,
    ReasoningEffort,
} from "../types/openai.js";
import { config } from "../config.js";

export class BadRequestError extends Error {
    readonly statusCode = 400;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateMessages(value: unknown): asserts value is OpenAIChatMessage[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new BadRequestError("messages must be a non-empty array");
    }
    if (value.length > config.maxContextMessages) {
        throw new BadRequestError(`messages exceeds the ${config.maxContextMessages}-message context limit`);
    }
    for (const [index, message] of value.entries()) {
        if (!isObject(message)) throw new BadRequestError(`messages[${index}] must be an object`);
        if (!new Set(["system", "developer", "user", "assistant", "tool"]).has(String(message.role))) {
            throw new BadRequestError(`messages[${index}].role is invalid`);
        }
    }
}

function validateTools(value: unknown): asserts value is OpenAIFunctionTool[] {
    if (value === undefined) return;
    if (!Array.isArray(value)) throw new BadRequestError("tools must be an array");
    for (const [index, tool] of value.entries()) {
        if (!isObject(tool) || tool.type !== "function" || !isObject(tool.function)) {
            throw new BadRequestError(`tools[${index}] must be a function tool`);
        }
        if (typeof tool.function.name !== "string" || tool.function.name.length === 0) {
            throw new BadRequestError(`tools[${index}].function.name is required`);
        }
    }
}

const REASONING_EFFORTS = new Set<ReasoningEffort>([
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
]);

function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
    if (value === undefined || value === "default") return undefined;
    if (value === "off") return "none";
    if (typeof value === "string" && REASONING_EFFORTS.has(value as ReasoningEffort)) {
        return value as ReasoningEffort;
    }
    throw new BadRequestError(
        "reasoning_effort must be one of: default, off, none, minimal, low, medium, high, xhigh, max",
    );
}

function validateToolChoice(value: unknown, tools: OpenAIFunctionTool[] | undefined): void {
    if (value === undefined) return;

    if (typeof value === "string") {
        if (!new Set(["none", "auto", "required"]).has(value)) {
            throw new BadRequestError("tool_choice must be none, auto, required, or a named function");
        }
        if (value === "required" && (!tools || tools.length === 0)) {
            throw new BadRequestError("tool_choice=required requires at least one tool");
        }
        return;
    }

    if (
        !isObject(value) ||
        value.type !== "function" ||
        !isObject(value.function) ||
        typeof value.function.name !== "string" ||
        value.function.name.length === 0
    ) {
        throw new BadRequestError("tool_choice named function is invalid");
    }

    const chosenName = value.function.name;
    if (!tools?.some((tool) => tool.function.name === chosenName)) {
        throw new BadRequestError(`tool_choice references unknown tool: ${chosenName}`);
    }
}

export function parseChatCompletionRequest(body: unknown): ChatCompletionRequest {
    if (!isObject(body)) throw new BadRequestError("request body must be a JSON object");
    if (typeof body.model !== "string" || body.model.length === 0) {
        throw new BadRequestError("model is required");
    }
    validateMessages(body.messages);
    validateTools(body.tools);
    const reasoningEffort = normalizeReasoningEffort(body.reasoning_effort);
    validateToolChoice(body.tool_choice, body.tools);
    if (body.metadata !== undefined && !isObject(body.metadata)) {
        throw new BadRequestError("metadata must be an object");
    }

    if (body.n !== undefined && body.n !== 1) {
        throw new BadRequestError("Only n=1 is supported");
    }

    const { reasoning_effort: _inputReasoningEffort, ...rest } = body;
    return {
        ...rest,
        ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
    } as unknown as ChatCompletionRequest;
}
