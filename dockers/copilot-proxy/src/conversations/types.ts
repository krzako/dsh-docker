import type { OpenAIFunctionTool, OpenAIChatMessage } from "../types/openai.js";

export type ProxySource = "opencode" | "deepseek-harness" | "open-webui";

export type ExternalIdentifiers = {
    opencode_session_id?: string;
    opencode_header_session_id?: string;
    opencode_affinity_session_id?: string;
    deepseek_conversation_id?: string;
    deepseek_session_id?: string;
    deepseek_thread_id?: string;
    openwebui_chat_id?: string;
    openwebui_session_id?: string;
    external_message_id?: string;
    run_id?: string;
};

export type CanonicalRequest = {
    requestId: string;
    source: ProxySource;
    userId?: string;
    conversationId: string;
    external: ExternalIdentifiers;
    model: string;
    messages: OpenAIChatMessage[];
    tools?: OpenAIFunctionTool[];
    stream: boolean;
    metadata: Record<string, unknown>;
};

export type StoredConversation = {
    id: string;
    source: ProxySource;
    userId?: string;
    createdAt: string;
    updatedAt: string;
    externalIds: ExternalIdentifiers;
    messages: OpenAIChatMessage[];
};

export class ConversationConflictError extends Error {
    readonly statusCode = 409;
}
