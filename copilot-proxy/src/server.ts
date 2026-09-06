import crypto from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";

import { config } from "./config.js";
import { CopilotGateway } from "./copilot/CopilotGateway.js";
import { BadRequestError, parseChatCompletionRequest } from "./openai/validation.js";
import type { ProxyToolCall, ProxyUsage } from "./types/openai.js";

const gateway = new CopilotGateway();

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
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > config.maxBodyBytes) throw new BadRequestError("Request body too large");
        chunks.push(buffer);
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

function sse(res: ServerResponse, payload: unknown): void {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
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
    const request = parseChatCompletionRequest(await readJson(req));
    const id = `chatcmpl-${crypto.randomUUID().replaceAll("-", "")}`;
    const created = Math.floor(Date.now() / 1000);
    const controller = new AbortController();
    req.once("aborted", () => controller.abort());
    res.once("close", () => {
        if (!res.writableEnded) controller.abort();
    });

    if (!request.stream) {
        const result = await gateway.complete(request, {}, controller.signal);
        json(res, 200, {
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
        });
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
    const ensureRole = () => {
        if (sentRole) return;
        sentRole = true;
        sse(res, {
            id,
            object: "chat.completion.chunk",
            created,
            model: request.model,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        });
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
                    });
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
                    });
                },
            },
            controller.signal,
        );

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
        });

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
            });
        }
        res.write("data: [DONE]\n\n");
        res.end();
    } catch (error) {
        if (!res.writableEnded) {
            sse(res, openAIError(error instanceof Error ? error.message : String(error), "server_error"));
            res.write("data: [DONE]\n\n");
            res.end();
        }
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
            const status = error instanceof BadRequestError ? 400 : 500;
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
