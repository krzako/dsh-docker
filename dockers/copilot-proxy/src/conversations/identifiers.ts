import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";

import type { ChatCompletionRequest } from "../types/openai.js";
import { field, header, IdentifierConflictError, type SourceAdapter } from "./sourceAdapter.js";
import { deepSeekHarnessAdapter } from "./sources/DeepSeekHarnessAdapter.js";
import { openCodeAdapter } from "./sources/OpenCodeAdapter.js";
import { openWebUIAdapter } from "./sources/OpenWebUIAdapter.js";
import type { ExternalIdentifiers, ProxySource } from "./types.js";

export { IdentifierConflictError };

const adapters: readonly SourceAdapter[] = [deepSeekHarnessAdapter, openWebUIAdapter, openCodeAdapter];
const adaptersBySource = new Map<ProxySource, SourceAdapter>(adapters.map((adapter) => [adapter.source, adapter]));

export function identifySource(req: IncomingMessage, request: ChatCompletionRequest): ProxySource | undefined {
    const explicit = field(request, "source") ?? header(req, "x-proxy-source");
    if (adaptersBySource.has(explicit as ProxySource)) return explicit as ProxySource;
    return adapters.find((adapter) => adapter.matches({ req, request }))?.source;
}

export function extractIdentifiers(
    req: IncomingMessage,
    request: ChatCompletionRequest,
    source: ProxySource,
): ExternalIdentifiers {
    const adapter = adaptersBySource.get(source);
    if (!adapter) throw new Error(`Unknown source: ${source}`);
    return adapter.extract({ req, request });
}

export function newRequestId(): string {
    return `req_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function newConversationId(): string {
    return `conv_${crypto.randomUUID().replaceAll("-", "")}`;
}
