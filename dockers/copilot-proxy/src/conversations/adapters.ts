import type { IncomingMessage } from "node:http";

import type { ChatCompletionRequest } from "../types/openai.js";
import { extractIdentifiers, identifySource, newRequestId } from "./identifiers.js";
import type { CanonicalRequest } from "./types.js";

function value(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function toCanonicalRequest(req: IncomingMessage, request: ChatCompletionRequest): CanonicalRequest {
    const source = identifySource(req, request);
    if (!source) throw new Error("Unable to recognize request source");
    const external = extractIdentifiers(req, request, source);
    const userId = value(request.user) ?? value(request.metadata?.user_id) ?? value(req.headers["x-user-id"]);
    const requestId =
        value(req.headers["x-request-id"]) ??
        value(request.metadata?.request_id) ??
        newRequestId();

    return {
        requestId,
        source,
        ...(userId ? { userId } : {}),
        conversationId: "",
        external,
        model: request.model,
        messages: request.messages,
        ...(request.tools ? { tools: request.tools } : {}),
        stream: request.stream === true,
        metadata: request.metadata ?? {},
    };
}
