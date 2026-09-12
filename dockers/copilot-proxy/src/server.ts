import crypto from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";

import { config } from "./config.js";
import { CopilotGateway } from "./copilot/CopilotGateway.js";
import { toCanonicalRequest } from "./conversations/adapters.js";
import { ConversationStore } from "./conversations/ConversationStore.js";
import { identifySource, IdentifierConflictError } from "./conversations/identifiers.js";
import { ConversationConflictError } from "./conversations/types.js";
import { proxyLogger, type LogSource } from "./logging/ProxyLogger.js";
import { BadRequestError, parseChatCompletionRequest } from "./openai/validation.js";
import type { ProxyToolCall, ProxyUsage } from "./types/openai.js";

const gateway = new CopilotGateway();
const conversations = new ConversationStore();

function json(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
    });
    res.end(body);
}

function openAIError(message: string, type = "invalid_request_error", code: string | null = null) {
    return { error: { message, type, param: null, code } };
}

function authorized(req: IncomingMessage): boolean {
    if (!config.apiKey) return true;
    const expected = `Bearer ${config.apiKey}`;
    return req.headers.authorization === expected;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString("utf8");
    try {
        return JSON.parse(text || "{}");
    } catch {
        throw new BadRequestError("Invalid JSON body");
    }
}

function openAIUsage(usage: ProxyUsage) {
    return {
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        total_tokens: usage.promptTokens + usage.completionTokens,
        prompt_tokens_details: {
            cached_tokens: usage.cachedTokens,
            cache_write_tokens: usage.cacheWriteTokens,
        },
        completion_tokens_details: {
            reasoning_tokens: usage.reasoningTokens,
        },
    };
}

function openAIToolCalls(calls: ProxyToolCall[]) {
    return calls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments ?? {}),
        },
    }));
}

function sse(res: ServerResponse, payload: unknown, capture?: string[]): void {
    const event = `data: ${JSON.stringify(payload)}\n\n`;
    capture?.push(event);
    res.write(event);
}

async function recordRequest(
    source: LogSource,
    req: IncomingMessage,
    inputBody: unknown,
    outputHeaders: Record<string, unknown>,
    outputBody: unknown,
): Promise<void> {
    try {
        await proxyLogger.recordRequest(source, req, inputBody, outputHeaders, outputBody);
    } catch (error) {
        console.error("Failed to write proxy request log", error);
    }
}

async function unknownSourceMessage(
    request: { model: string; stream?: boolean; stream_options?: { include_usage?: boolean } },
    req: IncomingMessage,
    inputBody: unknown,
    res: ServerResponse,
): Promise<void> {
    const id = `chatcmpl-${crypto.randomUUID().replaceAll("-", "")}`;
    const created = Math.floor(Date.now() / 1000);
    const content = "Copilot Proxy: Unable to recognize source";
    if (!request.stream) {
        const responseBody = {
            id,
            object: "chat.completion",
            created,
            model: request.model,
            choices: [
                {
                    index: 0,
                    message: { role: "assistant", content },
                    finish_reason: "stop",
                },
            ],
            usage: {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
            },
        };
        json(res, 200, responseBody);
        await recordRequest("unknown", req, inputBody, res.getHeaders(), responseBody);
        return;
    }

    res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
    });
    const output: string[] = [];
    sse(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model: request.model,
        choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    }, output);
    sse(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model: request.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    }, output);
    if (request.stream_options?.include_usage) {
        sse(res, {
            id,
            object: "chat.completion.chunk",
            created,
            model: request.model,
            choices: [],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }, output);
    }
    output.push("data: [DONE]\n\n");
    res.write("data: [DONE]\n\n");
    res.end();
    await recordRequest("unknown", req, inputBody, res.getHeaders(), output);
}

async function handleModels(res: ServerResponse): Promise<void> {
    const models = await gateway.listModels();
    json(res, 200, {
        object: "list",
        data: models
            .filter((model) => model.policy?.state !== "disabled")
            .map((model) => ({
                id: model.id,
                object: "model",
                created: 0,
                owned_by: "github-copilot",
                copilot: {
                    name: model.name,
                    capabilities: model.capabilities,
                    policy: model.policy,
                    billing: model.billing,
                    supported_reasoning_efforts: model.supportedReasoningEfforts,
                    default_reasoning_effort: model.defaultReasoningEffort,
                },
            })),
    });
}

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const inputBody = await readJson(req);
    const request = parseChatCompletionRequest(inputBody);
    const source = identifySource(req, request);
    await proxyLogger.log("debug", "request received", {
        method: req.method,
        url: req.url,
        source: source ?? "unknown",
    });
    if (!source) {
        await unknownSourceMessage(request, req, inputBody, res);
        return;
    }
    const canonical = toCanonicalRequest(req, request);
    canonical.conversationId = await conversations.resolve(
        canonical.source,
        canonical.userId,
        canonical.external,
        typeof request.metadata?.conversation_id === "string"
            ? request.metadata.conversation_id
            : request.conversation_id,
        canonical.requestId,
    );
    const requestState = await conversations.recordRequest(canonical);
    if (requestState === "duplicate") {
        throw new BadRequestError(`Duplicate request_id: ${canonical.requestId}`);
    }
    res.setHeader("x-request-id", canonical.requestId);
    const id = `chatcmpl-${crypto.randomUUID().replaceAll("-", "")}`;
    const created = Math.floor(Date.now() / 1000);
    const controller = new AbortController();
    req.once("aborted", () => controller.abort());
    res.once("close", () => {
        if (!res.writableEnded) controller.abort();
    });

    if (!request.stream) {
        try {
            const result = await gateway.complete(request, {}, controller.signal);
            await conversations.appendAssistant(canonical.conversationId, {
                role: "assistant",
                content: result.content || null,
                ...(result.toolCalls.length > 0
                    ? {
                          tool_calls: result.toolCalls.map((call) => ({
                              id: call.id,
                              type: "function" as const,
                              function: {
                                  name: call.name,
                                  arguments: JSON.stringify(call.arguments ?? {}),
                              },
                          })),
                      }
                    : {}),
            });
            await conversations.completeRequest(canonical.requestId, "completed");
            const responseBody = {
                id,
                object: "chat.completion",
                created,
                model: request.model,
                choices: [
                    {
                        index: 0,
                        message: {
                            role: "assistant",
                            content: result.content || null,
                            ...(result.toolCalls.length > 0
                                ? { tool_calls: openAIToolCalls(result.toolCalls) }
                                : {}),
                        },
                        finish_reason: result.finishReason,
                    },
                ],
                usage: openAIUsage(result.usage),
                copilot_usage: {
                    total_nano_aiu: result.usage.totalNanoAiu,
                    ai_credits: result.usage.aiCredits,
                    premium_request_cost: result.usage.premiumRequestCost,
                    cache_read_tokens: result.usage.cachedTokens,
                    cache_write_tokens: result.usage.cacheWriteTokens,
                    actual_model: result.actualModel,
                },
            };
            json(res, 200, responseBody);
            await recordRequest(canonical.source, req, inputBody, res.getHeaders(), responseBody);
        } catch (error) {
            await conversations.completeRequest(
                canonical.requestId,
                controller.signal.aborted ? "interrupted" : "failed",
            );
            throw error;
        }
        return;
    }

    res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
    });

    let sentRole = false;
    let toolIndex = 0;
    const output: string[] = [];
    const ensureRole = () => {
        if (sentRole) return;
        sentRole = true;
        sse(res, {
            id,
            object: "chat.completion.chunk",
            created,
            model: request.model,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        }, output);
    };

    try {
        const result = await gateway.complete(
            request,
            {
                onTextDelta: (text) => {
                    ensureRole();
                    sse(res, {
                        id,
                        object: "chat.completion.chunk",
                        created,
                        model: request.model,
                        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
                    }, output);
                },
                onToolCall: (call) => {
                    ensureRole();
                    sse(res, {
                        id,
                        object: "chat.completion.chunk",
                        created,
                        model: request.model,
                        choices: [
                            {
                                index: 0,
                                delta: {
                                    tool_calls: [
                                        {
                                            index: toolIndex++,
                                            id: call.id,
                                            type: "function",
                                            function: {
                                                name: call.name,
                                                arguments: JSON.stringify(call.arguments ?? {}),
                                            },
                                        },
                                    ],
                                },
                                finish_reason: null,
                            },
                        ],
                    }, output);
                },
            },
            controller.signal,
        );

        await conversations.appendAssistant(canonical.conversationId, {
            role: "assistant",
            content: result.content || null,
            ...(result.toolCalls.length > 0
                ? {
                      tool_calls: result.toolCalls.map((call) => ({
                          id: call.id,
                          type: "function" as const,
                          function: {
                              name: call.name,
                              arguments: JSON.stringify(call.arguments ?? {}),
                          },
                      })),
                  }
                : {}),
        });
        await conversations.completeRequest(canonical.requestId, "completed");

        ensureRole();
        sse(res, {
            id,
            object: "chat.completion.chunk",
            created,
            model: request.model,
            choices: [
                {
                    index: 0,
                    delta: {},
                    finish_reason: result.finishReason,
                },
            ],
        }, output);

        if (request.stream_options?.include_usage) {
            sse(res, {
                id,
                object: "chat.completion.chunk",
                created,
                model: request.model,
                choices: [],
                usage: openAIUsage(result.usage),
                copilot_usage: {
                    total_nano_aiu: result.usage.totalNanoAiu,
                    ai_credits: result.usage.aiCredits,
                    premium_request_cost: result.usage.premiumRequestCost,
                    cache_read_tokens: result.usage.cachedTokens,
                    cache_write_tokens: result.usage.cacheWriteTokens,
                    actual_model: result.actualModel,
                },
            }, output);
        }
        output.push("data: [DONE]\n\n");
        res.write("data: [DONE]\n\n");
        res.end();
        await recordRequest(canonical.source, req, inputBody, res.getHeaders(), output);
    } catch (error) {
        await conversations.completeRequest(
            canonical.requestId,
            controller.signal.aborted ? "interrupted" : "failed",
        );
        if (!res.writableEnded) {
            sse(res, openAIError(error instanceof Error ? error.message : String(error), "server_error"), output);
            output.push("data: [DONE]\n\n");
            res.write("data: [DONE]\n\n");
            res.end();
        }
        await recordRequest(canonical.source, req, inputBody, res.getHeaders(), output);
    }
}

export async function startServer(): Promise<http.Server> {
    await gateway.start();

    const server = http.createServer(async (req, res) => {
        try {
            if (req.method === "GET" && req.url === "/health") {
                json(res, 200, { ok: true });
                return;
            }

            if (!authorized(req)) {
                json(res, 401, openAIError("Invalid API key", "authentication_error"));
                return;
            }

            if (req.method === "GET" && req.url === "/v1/models") {
                await handleModels(res);
                return;
            }

            if (req.method === "GET" && req.url === "/v1/copilot/quota") {
                json(res, 200, await gateway.getQuota());
                return;
            }

            if (req.method === "POST" && req.url === "/v1/chat/completions") {
                await handleChat(req, res);
                return;
            }

            json(res, 404, openAIError("Not found", "invalid_request_error", "not_found"));
        } catch (error) {
            await proxyLogger.log("error", "request failed", {
                method: req.method,
                url: req.url,
                error: error instanceof Error ? error.message : String(error),
            });
            const status =
                error instanceof IdentifierConflictError || error instanceof ConversationConflictError
                    ? error.statusCode
                    : error instanceof BadRequestError
                      ? 400
                      : 500;
            const message = error instanceof Error ? error.message : String(error);
            json(res, status, openAIError(message, status === 400 ? "invalid_request_error" : "server_error"));
        }
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
            server.off("error", reject);
            resolve();
        });
    });

    const shutdown = async () => {
        server.close();
        await gateway.stop();
    };
    process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
    process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

    return server;
}
