import { ConversationStore } from "../conversations/ConversationStore.js";
import type { CopilotSessionBinding } from "../conversations/types.js";
import type { ChatCompletionRequest, OpenAIChatMessage } from "../types/openai.js";
import { CopilotGateway, type CompletionCallbacks, type CopilotCompletion } from "./CopilotGateway.js";
import { messageHashes, planSession } from "./sessionPlan.js";

export const SESSION_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const RETENTION_SWEEP_MS = 60 * 60 * 1000;

function assistantMessage(result: CopilotCompletion): OpenAIChatMessage {
    return {
        role: "assistant",
        content: result.content || null,
        ...(result.reasoningContent ? { reasoning_content: result.reasoningContent } : {}),
        ...(result.toolCalls.length > 0 ? {
            tool_calls: result.toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
            })),
        } : {}),
    };
}

/** Serializes turns per proxy conversation while allowing independent agents to run concurrently. */
export class CopilotSessionManager {
    readonly #gateway: CopilotGateway;
    readonly #store: ConversationStore;
    readonly #locks = new Map<string, Promise<void>>();
    readonly activeConversationIds = new Set<string>();
    #retentionTimer: NodeJS.Timeout | undefined;
    #cleanupPromise: Promise<void> | undefined;

    constructor(gateway: CopilotGateway, store: ConversationStore) {
        this.#gateway = gateway;
        this.#store = store;
    }

    startRetention(): void {
        if (this.#retentionTimer) return;
        void this.pruneExpired().catch((error) => console.error("Copilot session cleanup failed", error));
        this.#retentionTimer = setInterval(() => {
            void this.pruneExpired().catch((error) => console.error("Copilot session cleanup failed", error));
        }, RETENTION_SWEEP_MS);
        this.#retentionTimer.unref();
    }

    stopRetention(): void {
        if (this.#retentionTimer) clearInterval(this.#retentionTimer);
        this.#retentionTimer = undefined;
    }

    async pruneExpired(now = new Date()): Promise<void> {
        await this.#store.takeExpiredCopilotSessions(
            new Date(now.getTime() - SESSION_RETENTION_MS),
            this.activeConversationIds,
        );
        await this.flushPendingDeletes();
    }

    async flushPendingDeletes(): Promise<void> {
        if (this.#cleanupPromise) return this.#cleanupPromise;
        this.#cleanupPromise = (async () => {
            for (const id of await this.#store.pendingSessionDeletes()) {
                try {
                    await this.#gateway.deleteSession(id);
                    await this.#store.acknowledgeSessionDelete(id);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    if (/session.*(not found|does not exist|unknown)/i.test(message)) {
                        await this.#store.acknowledgeSessionDelete(id);
                    } else {
                        console.error(`Failed to delete Copilot session ${id}: ${message}`);
                    }
                }
            }
        })();
        try {
            await this.#cleanupPromise;
        } finally {
            this.#cleanupPromise = undefined;
        }
    }

    async complete(
        conversationId: string,
        request: ChatCompletionRequest,
        callbacks: CompletionCallbacks = {},
        signal?: AbortSignal,
    ): Promise<CopilotCompletion> {
        const previous = this.#locks.get(conversationId) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => { release = resolve; });
        this.#locks.set(conversationId, current);
        await previous;
        this.activeConversationIds.add(conversationId);
        let attempted = false;
        try {
            if (signal?.aborted) throw new Error("Request aborted by client");
            const binding = await this.#store.getCopilotSession(conversationId);
            const plan = planSession(request, binding);
            attempted = true;
            const result = await this.#gateway.complete(request, callbacks, signal, plan);
            const updated: CopilotSessionBinding = {
                id: result.sessionId,
                model: request.model,
                configHash: plan.configHash,
                messageHashes: messageHashes([...request.messages, assistantMessage(result)]),
                lastUsedAt: new Date().toISOString(),
            };
            await this.#store.appendAssistant(conversationId, assistantMessage(result), updated, request.messages);
            await this.flushPendingDeletes().catch((cleanupError) => console.error("Copilot session cleanup failed", cleanupError));
            return result;
        } catch (error) {
            if (attempted) {
                await this.#store.clearCopilotSession(conversationId);
                await this.flushPendingDeletes().catch((cleanupError) => console.error("Copilot session cleanup failed", cleanupError));
            }
            throw error;
        } finally {
            this.activeConversationIds.delete(conversationId);
            if (this.#locks.get(conversationId) === current) this.#locks.delete(conversationId);
            release();
        }
    }
}
