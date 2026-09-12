import fs from "node:fs/promises";
import path from "node:path";
import { CopilotClient, RuntimeConnection, type CopilotSession, type ModelInfo, type Tool } from "@github/copilot-sdk";

import { config } from "../config.js";
import { proxyLogger } from "../logging/ProxyLogger.js";
import { buildCopilotInput } from "../openai/serializeMessages.js";
import type {
    ChatCompletionRequest,
    ProxyToolCall,
    ProxyUsage,
} from "../types/openai.js";

export type CompletionCallbacks = {
    onTextDelta?: (text: string) => void;
    onToolCall?: (call: ProxyToolCall) => void;
};

export type CopilotCompletion = {
    content: string;
    toolCalls: ProxyToolCall[];
    usage: ProxyUsage;
    finishReason: string;
    actualModel?: string;
};

type UsageEventData = {
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    finishReason?: string;
    copilotUsage?: { totalNanoAiu?: number };
};

function mapFinishReason(value: string | undefined, hasToolCalls: boolean): string {
    if (hasToolCalls) return "tool_calls";
    switch (value) {
        case "length":
            return "length";
        case "content_filter":
            return "content_filter";
        case "stop":
        default:
            return "stop";
    }
}

const RUNTIME_START_RETRY_DELAY_MS = 5000;

export class CopilotGateway {
    #client: CopilotClient | undefined;
    #started = false;

    #runningClient(): CopilotClient {
        if (!this.#started || !this.#client) throw new Error("Copilot runtime is not started");
        return this.#client;
    }

    #createClient(): CopilotClient {
        return new CopilotClient({
            mode: "empty",
            connection: RuntimeConnection.forUri(config.copilotRuntimeUrl),
            logLevel: config.copilotSdkLogLevel,
        });
    }

    async start(): Promise<void> {
        if (this.#started) return;
        await fs.mkdir(config.copilotHome, { recursive: true });
        for (;;) {
            const client = this.#createClient();
            try {
                await client.start();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.error(
                    `Copilot runtime not ready, retrying in ${RUNTIME_START_RETRY_DELAY_MS}ms: ${message}`,
                );
                await proxyLogger.log("warning", "Copilot runtime not ready; retrying", { error: message });
                await new Promise((resolve) => setTimeout(resolve, RUNTIME_START_RETRY_DELAY_MS));
                continue;
            }
            this.#client = client;
            this.#started = true;
            return;
        }
    }

    async stop(): Promise<void> {
        if (!this.#started) return;
        await this.#client?.stop();
        this.#started = false;
    }

    async listModels(): Promise<ModelInfo[]> {
        await this.start();
        return this.#runningClient().listModels();
    }

    async getQuota(): Promise<unknown> {
        await this.start();
        return this.#runningClient().rpc.account.getQuota({});
    }

    async complete(
        request: ChatCompletionRequest,
        callbacks: CompletionCallbacks = {},
        signal?: AbortSignal,
    ): Promise<CopilotCompletion> {
        await this.start();

        const { systemMessage, prompt } = buildCopilotInput(request);
        const toolCalls: ProxyToolCall[] = [];
        let content = "";
        let providerFinishReason: string | undefined;
        let actualModel: string | undefined;
        const usage: ProxyUsage = {
            promptTokens: 0,
            completionTokens: 0,
            cachedTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
        };

        let activeSession: CopilotSession | undefined;

        const selectedToolName =
            typeof request.tool_choice === "object" ? request.tool_choice.function.name : undefined;

        const exposedOpenAITools = (request.tool_choice === "none" ? [] : (request.tools ?? [])).filter(
            (tool) => selectedToolName === undefined || tool.function.name === selectedToolName,
        );

        const tools: Tool[] = exposedOpenAITools.map(
            (tool): Tool => ({
                name: tool.function.name,
                description: tool.function.description ?? `OpenAI function ${tool.function.name}`,
                parameters: tool.function.parameters ?? { type: "object", properties: {} },
                overridesBuiltInTool: true,
                skipPermission: true,
                defer: "never",
                handler: async (args: unknown, invocation) => {
                    const call: ProxyToolCall = {
                        id: invocation.toolCallId,
                        name: invocation.toolName,
                        arguments: args,
                    };
                    toolCalls.push(call);
                    callbacks.onToolCall?.(call);

                    // The stable SDK versions do not all expose terminal custom tools.
                    // Abort this Copilot turn immediately after the tool request is captured;
                    // the OpenAI-compatible caller/harness executes the real tool instead.
                    if (activeSession) {
                        setImmediate(() => void activeSession?.abort().catch(() => undefined));
                    }
                    return "Tool execution is delegated to the OpenAI-compatible API client.";
                },
            }),
        );

        if (selectedToolName && tools.length === 0) {
            throw new Error(`tool_choice references unknown tool: ${selectedToolName}`);
        }

        const workingDirectory = path.join(config.copilotHome, "proxy-workdir");
        await fs.mkdir(workingDirectory, { recursive: true });

        // mode:"empty" intentionally provides no ambient Copilot CLI tools/skills/MCP.
        // availableTools is mandatory in empty mode, including the [] case.
        const session = await this.#runningClient().createSession({
            model: request.model,
            ...(request.reasoning_effort
                ? {
                      reasoningEffort: request.reasoning_effort,
                  }
                : {}),
            streaming: true,
            systemMessage: { mode: "replace", content: systemMessage },
            availableTools: tools.length > 0 ? ["custom:*"] : [],
            tools,
            infiniteSessions: { enabled: false },
            memory: { enabled: false },
            workingDirectory,
            enableConfigDiscovery: false,
        });
        activeSession = session;

        let aborted = false;
        const abort = () => {
            aborted = true;
            void session.abort().catch(() => undefined);
        };
        signal?.addEventListener("abort", abort, { once: true });

        try {
            await new Promise<void>((resolve, reject) => {
                let settled = false;
                let unsubscribe: () => void = () => undefined;
                const finish = (fn: () => void) => {
                    if (settled) return;
                    settled = true;
                    unsubscribe();
                    fn();
                };

                unsubscribe = session.on((event) => {
                    // Ignore sub-agent traffic if a future SDK/runtime ever emits it here.
                    if ("agentId" in event && event.agentId) return;

                    switch (event.type) {
                        case "assistant.message_delta": {
                            const delta = event.data.deltaContent ?? "";
                            if (delta) {
                                content += delta;
                                callbacks.onTextDelta?.(delta);
                            }
                            break;
                        }
                        case "assistant.message": {
                            if (!content && event.data.content) content = event.data.content;
                            break;
                        }
                        case "assistant.usage": {
                            const data = event.data as UsageEventData;
                            actualModel = data.model ?? actualModel;
                            providerFinishReason = data.finishReason ?? providerFinishReason;
                            usage.promptTokens += data.inputTokens ?? 0;
                            usage.completionTokens += data.outputTokens ?? 0;
                            usage.cachedTokens += data.cacheReadTokens ?? 0;
                            usage.cacheWriteTokens += data.cacheWriteTokens ?? 0;
                            usage.reasoningTokens += data.reasoningTokens ?? 0;
                            if (typeof data.copilotUsage?.totalNanoAiu === "number") {
                                usage.totalNanoAiu =
                                    (usage.totalNanoAiu ?? 0) + data.copilotUsage.totalNanoAiu;
                                usage.aiCredits = usage.totalNanoAiu / 1e9;
                            }
                            break;
                        }
                        case "session.error":
                            // We intentionally abort after capturing a delegated tool call.
                            // Some runtimes surface that abort as session.error rather than idle.
                            if (toolCalls.length > 0) finish(resolve);
                            else finish(() => reject(new Error(event.data.message ?? "Copilot session error")));
                            break;
                        case "session.idle":
                            finish(resolve);
                            break;
                    }
                });

                session.send({ prompt }).catch((error) => {
                    if (toolCalls.length > 0) finish(resolve);
                    else finish(() => reject(error));
                });
            });

            if (aborted) throw new Error("Request aborted by client");

            try {
                const metrics = await session.rpc.usage.getMetrics();
                if (usage.totalNanoAiu === undefined && typeof metrics.totalNanoAiu === "number") {
                    usage.totalNanoAiu = metrics.totalNanoAiu;
                    usage.aiCredits = metrics.totalNanoAiu / 1e9;
                }
                if (typeof metrics.totalPremiumRequestCost === "number") {
                    usage.premiumRequestCost = metrics.totalPremiumRequestCost;
                }
            } catch {
                // Token usage events above remain usable even if accumulated metrics are unavailable.
            }

            return {
                content,
                toolCalls,
                usage,
                finishReason: mapFinishReason(providerFinishReason, toolCalls.length > 0),
                ...(actualModel ? { actualModel } : {}),
            };
        } finally {
            signal?.removeEventListener("abort", abort);
            await session.disconnect().catch(() => undefined);
        }
    }
}
