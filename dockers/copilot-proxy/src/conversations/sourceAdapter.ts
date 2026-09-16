import type { IncomingMessage } from "node:http";

import type { ChatCompletionRequest } from "../types/openai.js";
import type { ExternalIdentifiers, ProxySource } from "./types.js";

export type SourceContext = { req: IncomingMessage; request: ChatCompletionRequest };

export interface SourceAdapter {
    readonly source: ProxySource;
    matches(context: SourceContext): boolean;
    extract(context: SourceContext): ExternalIdentifiers;
}

export function value(input: unknown): string | undefined {
    return typeof input === "string" && input.trim() ? input.trim() : undefined;
}

export function header(req: IncomingMessage, name: string): string | undefined {
    return value(req.headers[name]);
}

export function field(request: ChatCompletionRequest, name: string): string | undefined {
    return value(request.metadata?.[name]) ?? value(request[name as keyof ChatCompletionRequest]);
}

export function urlIdentifier(req: IncomingMessage, key: string): string | undefined {
    if (!req.url) return undefined;
    const url = new URL(req.url, "http://proxy.invalid");
    return value(url.searchParams.get(key)) ??
        value(url.pathname.match(new RegExp(`/${key}/([^/]+)`))?.[1]);
}

export function assign(external: ExternalIdentifiers, key: keyof ExternalIdentifiers, input: unknown): void {
    const normalized = value(input);
    if (normalized) external[key] = normalized;
}

export class IdentifierConflictError extends Error {
    readonly statusCode = 409;
}
