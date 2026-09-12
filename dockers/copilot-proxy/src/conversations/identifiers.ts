import type { IncomingMessage } from "node:http";
import crypto from "node:crypto";

import type { ChatCompletionRequest } from "../types/openai.js";
import type { ExternalIdentifiers, ProxySource } from "./types.js";

export class IdentifierConflictError extends Error {
    readonly statusCode = 409;
}

function stringValue(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function header(req: IncomingMessage, name: string): string | undefined {
    return stringValue(req.headers[name]);
}

function looksLikeOpenWebUI(req: IncomingMessage): boolean {
    const userAgent = header(req, "user-agent")?.toLowerCase() ?? "";
    return userAgent.includes("python/") && userAgent.includes("aiohttp/");
}

function looksLikeOpenCode(req: IncomingMessage): boolean {
    return (header(req, "user-agent")?.toLowerCase() ?? "").startsWith("opencode/");
}

function urlIdentifier(req: IncomingMessage, key: string): string | undefined {
    if (!req.url) return undefined;
    const url = new URL(req.url, "http://proxy.invalid");
    return stringValue(url.searchParams.get(key)) ??
        stringValue(url.pathname.match(new RegExp(`/${key}/([^/]+)`))?.[1]);
}

function metadataValue(request: ChatCompletionRequest, key: string): string | undefined {
    return stringValue(request.metadata?.[key]) ?? stringValue(request[key as keyof ChatCompletionRequest]);
}

export function identifySource(req: IncomingMessage, request: ChatCompletionRequest): ProxySource | undefined {
    const explicit = metadataValue(request, "source") ?? header(req, "x-proxy-source");
    if (explicit === "opencode" || explicit === "deepseek-harness" || explicit === "open-webui") {
        return explicit;
    }
    if (
        header(req, "x-session-id") ||
        looksLikeOpenCode(req) ||
        metadataValue(request, "opencode_session_id") ||
        urlIdentifier(req, "session")
    ) {
        return "opencode";
    }
    if (
        metadataValue(request, "conversation_id") ||
        metadataValue(request, "deepseek_conversation_id") ||
        metadataValue(request, "thread_id")
    ) {
        return "deepseek-harness";
    }
    if (
        metadataValue(request, "chat_id") ||
        metadataValue(request, "openwebui_chat_id")
    ) {
        return "open-webui";
    }
    if (looksLikeOpenWebUI(req)) return "open-webui";
    return undefined;
}

export function extractIdentifiers(
    req: IncomingMessage,
    request: ChatCompletionRequest,
    source: ProxySource,
): ExternalIdentifiers {
    const metadata = request.metadata ?? {};
    const result: ExternalIdentifiers = {};
    const set = (key: keyof ExternalIdentifiers, value: unknown) => {
        const normalized = stringValue(value);
        if (normalized) result[key] = normalized;
    };

    if (source === "opencode") {
        const bodySession = metadataValue(request, "session_id");
        const explicitSession = metadataValue(request, "opencode_session_id");
        const urlSession = urlIdentifier(req, "session");
        const bodySessions = [bodySession, explicitSession].filter(
            (value, index, values): value is string => Boolean(value) && values.indexOf(value) === index,
        );
        if (bodySessions.length > 1 || (urlSession && bodySessions.some((value) => value !== urlSession))) {
            throw new IdentifierConflictError("OpenCode session identifiers conflict");
        }
        const headerSession = header(req, "x-session-id");
        const affinitySession = header(req, "x-session-affinity");
        set("opencode_session_id", urlSession ?? bodySession ?? explicitSession ?? headerSession);
        set("opencode_header_session_id", headerSession);
        set("opencode_affinity_session_id", affinitySession);
        set("external_message_id", metadataValue(request, "message_id"));
    } else if (source === "deepseek-harness") {
        set("deepseek_conversation_id", metadataValue(request, "conversation_id"));
        set("deepseek_session_id", metadataValue(request, "session_id"));
        set("deepseek_thread_id", metadataValue(request, "thread_id"));
        set("external_message_id", metadataValue(request, "message_id"));
        set("run_id", metadataValue(request, "run_id"));
    } else {
        set("openwebui_chat_id", metadataValue(request, "chat_id"));
        set("openwebui_chat_id", metadataValue(request, "openwebui_chat_id"));
        set("openwebui_session_id", metadataValue(request, "session_id"));
        set("openwebui_session_id", metadataValue(request, "openwebui_session_id"));
        set("external_message_id", metadataValue(request, "message_id"));
    }

    if (
        result.opencode_session_id &&
        result.opencode_header_session_id &&
        result.opencode_session_id !== result.opencode_header_session_id
    ) {
        throw new IdentifierConflictError(
            "OpenCode session_id conflicts with its transport session header; refusing to merge sessions",
        );
    }
    if (
        result.opencode_header_session_id &&
        result.opencode_affinity_session_id &&
        result.opencode_header_session_id !== result.opencode_affinity_session_id
    ) {
        throw new IdentifierConflictError(
            "OpenCode x-session-id conflicts with x-session-affinity; refusing to merge sessions",
        );
    }
    return result;
}

export function explicitConversationId(request: ChatCompletionRequest): string | undefined {
    return stringValue(request.metadata?.conversation_id);
}

export function newRequestId(): string {
    return `req_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function newConversationId(): string {
    return `conv_${crypto.randomUUID().replaceAll("-", "")}`;
}
