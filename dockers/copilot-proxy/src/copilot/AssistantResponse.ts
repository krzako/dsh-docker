import type { SessionEvent } from "@github/copilot-sdk";

export type AssistantResponseCallbacks = {
    onTextDelta?: (text: string) => void;
    onReasoningDelta?: (text: string) => void;
};

/** Accumulates Copilot assistant events and preserves reasoning-before-content output order. */
export class AssistantResponse {
    content = "";
    reasoningContent = "";

    readonly #callbacks: AssistantResponseCallbacks;
    readonly #streamedMessageIds = new Set<string>();
    readonly #streamedReasoningIds = new Set<string>();
    readonly #completedMessageIds = new Set<string>();
    readonly #completedReasoningIds = new Set<string>();
    #textEmitted = false;

    constructor(callbacks: AssistantResponseCallbacks) {
        this.#callbacks = callbacks;
    }

    /** Consume one root-agent SDK event. */
    accept(event: SessionEvent): void {
        switch (event.type) {
            case "assistant.reasoning_delta": {
                const delta = event.data.deltaContent ?? "";
                if (!delta) return;
                this.#streamedReasoningIds.add(event.data.reasoningId);
                this.reasoningContent += delta;
                if (!this.#textEmitted) this.#callbacks.onReasoningDelta?.(delta);
                return;
            }
            case "assistant.reasoning": {
                const reasoningId = event.data.reasoningId;
                if (
                    !this.#streamedReasoningIds.has(reasoningId) &&
                    !this.#completedReasoningIds.has(reasoningId) &&
                    event.data.content
                ) {
                    this.#completedReasoningIds.add(reasoningId);
                    this.reasoningContent += event.data.content;
                    if (!this.#textEmitted) {
                        this.#callbacks.onReasoningDelta?.(event.data.content);
                    }
                }
                return;
            }
            case "assistant.message_delta": {
                const delta = event.data.deltaContent ?? "";
                if (!delta) return;

                // Copilot may not emit the complete assistant.reasoning event until
                // after all message deltas. The first text delta is therefore the
                // reliable phase boundary: any preceding reasoning deltas are done,
                // and ordinary content must remain genuinely streaming.
                this.#streamedMessageIds.add(event.data.messageId);
                this.content += delta;
                this.#textEmitted = true;
                this.#callbacks.onTextDelta?.(delta);
                return;
            }
            case "assistant.message": {
                // Some providers expose readable thinking only on the complete
                // assistant message instead of separate reasoning events.
                if (!this.reasoningContent && event.data.reasoningText) {
                    this.reasoningContent = event.data.reasoningText;
                    // In a non-streaming response this still precedes the complete
                    // content. During streaming, never inject late reasoning after
                    // text deltas have already been forwarded.
                    if (!this.#textEmitted) {
                        this.#callbacks.onReasoningDelta?.(event.data.reasoningText);
                    }
                }
                const messageId = event.data.messageId;
                if (
                    !this.#streamedMessageIds.has(messageId) &&
                    !this.#completedMessageIds.has(messageId) &&
                    event.data.content
                ) {
                    this.#completedMessageIds.add(messageId);
                    this.content += event.data.content;
                    this.#textEmitted = true;
                    this.#callbacks.onTextDelta?.(event.data.content);
                }
                return;
            }
        }
    }
}
