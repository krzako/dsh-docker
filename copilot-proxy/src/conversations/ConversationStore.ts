import fs from "node:fs/promises";
import path from "node:path";

import { config } from "../config.js";
import type { OpenAIChatMessage } from "../types/openai.js";
import { newConversationId } from "./identifiers.js";
import {
    ConversationConflictError,
    type CanonicalRequest,
    type ExternalIdentifiers,
    type ProxySource,
    type StoredConversation,
} from "./types.js";

type StoreFile = {
    conversations: StoredConversation[];
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

function externalEntries(external: ExternalIdentifiers): Array<[string, string]> {
    return Object.entries(external).filter((entry): entry is [string, string] => Boolean(entry[1]));
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
            for (const conversation of data.conversations) {
                if (conversation.source !== source || conversation.userId !== userId) continue;
                const ids = externalEntries(conversation.externalIds);
                if (ids.some(([key, value]) => external[key as keyof ExternalIdentifiers] === value)) {
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

    async appendAssistant(conversationId: string, message: OpenAIChatMessage): Promise<void> {
        return this.#exclusive(async () => {
            const data = await this.#data();
            const conversation = data.conversations.find((item) => item.id === conversationId);
            if (!conversation) throw new Error(`Conversation not found: ${conversationId}`);
            conversation.messages.push(message);
            conversation.updatedAt = now();
            await this.#persist(data);
        });
    }
}
