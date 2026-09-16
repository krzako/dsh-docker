import fs from "node:fs/promises";
import path from "node:path";

import { config } from "../config.js";
import type { OpenAIChatMessage } from "../types/openai.js";
import { newConversationId } from "./identifiers.js";
import {
    ConversationConflictError,
    type CanonicalRequest,
    type CopilotSessionBinding,
    type ExternalIdentifiers,
    type ProxySource,
    type StoredConversation,
} from "./types.js";

type StoreFile = {
    conversations: StoredConversation[];
    pendingSessionDeletes?: string[];
    requests: Record<
        string,
        {
            conversationId: string;
            source: ProxySource;
            userId?: string;
            externalMessageId?: string;
            status: string;
            createdAt: string;
        }
    >;
};

function now(): string {
    return new Date().toISOString();
}

function identityEntry(source: ProxySource, external: ExternalIdentifiers): [keyof ExternalIdentifiers, string] | undefined {
    const keys: Array<keyof ExternalIdentifiers> = source === "opencode"
        ? ["opencode_session_id"]
        : source === "deepseek-harness"
            ? ["deepseek_conversation_id", "deepseek_session_id", "deepseek_thread_id"]
            : ["openwebui_chat_id", "openwebui_session_id"];
    for (const key of keys) {
        if (external[key]) return [key, external[key]];
    }
    return undefined;
}

export class ConversationStore {
    #file: string;
    #loaded: Promise<StoreFile> | undefined;
    #write: Promise<void> = Promise.resolve();
    #lock: Promise<void> = Promise.resolve();

    constructor(file = config.conversationStorePath) {
        this.#file = file;
    }

    async #data(): Promise<StoreFile> {
        this.#loaded ??= fs
            .readFile(this.#file, "utf8")
            .then((raw) => JSON.parse(raw) as StoreFile)
            .catch((error: unknown) => {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                    return { conversations: [], requests: {} };
                }
                throw error;
            });
        return this.#loaded;
    }

    async #persist(data: StoreFile): Promise<void> {
        this.#write = this.#write.then(async () => {
            await fs.mkdir(path.dirname(this.#file), { recursive: true });
            const temp = `${this.#file}.tmp`;
            await fs.writeFile(temp, JSON.stringify(data), { mode: 0o600 });
            await fs.rename(temp, this.#file);
        });
        await this.#write;
    }

    async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.#lock;
        let release!: () => void;
        this.#lock = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
    }

    async resolve(
        source: ProxySource,
        userId: string | undefined,
        external: ExternalIdentifiers,
        requestedId: string | undefined,
        requestId?: string,
    ): Promise<string> {
        return this.#exclusive(async () => {
            const data = await this.#data();
            if (requestId) {
                const previous = data.requests[requestId];
                if (previous) {
                    if (previous.source !== source || previous.userId !== userId) {
                        throw new ConversationConflictError("request_id belongs to another source or user");
                    }
                    return previous.conversationId;
                }
            }
            if (requestedId) {
                const sameId = data.conversations.find((item) => item.id === requestedId);
                if (sameId && (sameId.source !== source || sameId.userId !== userId)) {
                    throw new ConversationConflictError("conversation_id belongs to another source or user");
                }
            }
            const matches = new Set<string>();
            const identity = identityEntry(source, external);
            for (const conversation of data.conversations) {
                if (conversation.source !== source || conversation.userId !== userId) continue;
                const storedIdentity = identityEntry(source, conversation.externalIds);
                if (identity && storedIdentity && identity[0] === storedIdentity[0] && identity[1] === storedIdentity[1]) {
                    matches.add(conversation.id);
                }
                if (requestedId && conversation.id === requestedId) matches.add(conversation.id);
            }
            if (matches.size > 1) throw new Error("External identifiers resolve to multiple conversations");
            const existing = [...matches][0];
            if (existing) {
                const conversation = data.conversations.find((item) => item.id === existing);
                if (!conversation) throw new Error(`Conversation not found: ${existing}`);
                conversation.externalIds = { ...conversation.externalIds, ...external };
                conversation.updatedAt = now();
                await this.#persist(data);
                return existing;
            }

            const conversation: StoredConversation = {
                id: requestedId ?? newConversationId(),
                source,
                ...(userId ? { userId } : {}),
                createdAt: now(),
                updatedAt: now(),
                externalIds: external,
                messages: [],
            };
            data.conversations.push(conversation);
            await this.#persist(data);
            return conversation.id;
        });
    }

    async recordRequest(request: CanonicalRequest): Promise<"new" | "duplicate"> {
        return this.#exclusive(async () => {
            const data = await this.#data();
            if (data.requests[request.requestId]) return "duplicate";
            if (
                request.external.external_message_id &&
                Object.values(data.requests).some(
                    (stored) =>
                        stored.conversationId === request.conversationId &&
                        stored.externalMessageId === request.external.external_message_id,
                )
            ) {
                return "duplicate";
            }
            data.requests[request.requestId] = {
                conversationId: request.conversationId,
                source: request.source,
                ...(request.userId ? { userId: request.userId } : {}),
                ...(request.external.external_message_id
                    ? { externalMessageId: request.external.external_message_id }
                    : {}),
                status: "streaming",
                createdAt: now(),
            };
            const conversation = data.conversations.find((item) => item.id === request.conversationId);
            if (!conversation) throw new Error(`Conversation not found: ${request.conversationId}`);
            conversation.updatedAt = now();
            conversation.messages = request.messages;
            await this.#persist(data);
            return "new";
        });
    }

    async completeRequest(requestId: string, status: "completed" | "interrupted" | "failed"): Promise<void> {
        return this.#exclusive(async () => {
            const data = await this.#data();
            const stored = data.requests[requestId];
            if (!stored) return;
            stored.status = status;
            await this.#persist(data);
        });
    }

    async appendAssistant(
        conversationId: string,
        message: OpenAIChatMessage,
        binding?: CopilotSessionBinding,
        inputMessages?: OpenAIChatMessage[],
    ): Promise<void> {
        return this.#exclusive(async () => {
            const data = await this.#data();
            const conversation = data.conversations.find((item) => item.id === conversationId);
            if (!conversation) throw new Error(`Conversation not found: ${conversationId}`);
            if (inputMessages) conversation.messages = [...inputMessages];
            conversation.messages.push(message);
            if (binding) {
                const previousId = conversation.copilotSession?.id;
                if (previousId && previousId !== binding.id) {
                    data.pendingSessionDeletes ??= [];
                    if (!data.pendingSessionDeletes.includes(previousId)) data.pendingSessionDeletes.push(previousId);
                }
                conversation.copilotSession = binding;
            }
            conversation.updatedAt = now();
            await this.#persist(data);
        });
    }

    async getCopilotSession(conversationId: string): Promise<CopilotSessionBinding | undefined> {
        return this.#exclusive(async () => {
            const data = await this.#data();
            const conversation = data.conversations.find((item) => item.id === conversationId);
            if (!conversation) throw new Error(`Conversation not found: ${conversationId}`);
            const binding = conversation.copilotSession;
            return binding ? { ...binding, messageHashes: [...binding.messageHashes] } : undefined;
        });
    }

    async setCopilotSession(conversationId: string, binding: CopilotSessionBinding): Promise<void> {
        return this.#exclusive(async () => {
            const data = await this.#data();
            const conversation = data.conversations.find((item) => item.id === conversationId);
            if (!conversation) throw new Error(`Conversation not found: ${conversationId}`);
            conversation.copilotSession = binding;
            conversation.updatedAt = now();
            await this.#persist(data);
        });
    }

    async clearCopilotSession(conversationId: string): Promise<string | undefined> {
        return this.#exclusive(async () => {
            const data = await this.#data();
            const conversation = data.conversations.find((item) => item.id === conversationId);
            if (!conversation?.copilotSession) return undefined;
            const id = conversation.copilotSession.id;
            delete conversation.copilotSession;
            data.pendingSessionDeletes ??= [];
            if (!data.pendingSessionDeletes.includes(id)) data.pendingSessionDeletes.push(id);
            await this.#persist(data);
            return id;
        });
    }

    async takeExpiredCopilotSessions(cutoff: Date, activeConversationIds: ReadonlySet<string> = new Set()): Promise<string[]> {
        return this.#exclusive(async () => {
            const data = await this.#data();
            const ids: string[] = [];
            for (const conversation of data.conversations) {
                const binding = conversation.copilotSession;
                if (!binding || activeConversationIds.has(conversation.id)) continue;
                if (Date.parse(binding.lastUsedAt) > cutoff.getTime()) continue;
                ids.push(binding.id);
                delete conversation.copilotSession;
            }
            if (ids.length > 0) {
                data.pendingSessionDeletes ??= [];
                for (const id of ids) {
                    if (!data.pendingSessionDeletes.includes(id)) data.pendingSessionDeletes.push(id);
                }
                await this.#persist(data);
            }
            return ids;
        });
    }

    async pendingSessionDeletes(): Promise<string[]> {
        return this.#exclusive(async () => [...((await this.#data()).pendingSessionDeletes ?? [])]);
    }

    async acknowledgeSessionDelete(id: string): Promise<void> {
        return this.#exclusive(async () => {
            const data = await this.#data();
            data.pendingSessionDeletes = (data.pendingSessionDeletes ?? []).filter((item) => item !== id);
            await this.#persist(data);
        });
    }
}
