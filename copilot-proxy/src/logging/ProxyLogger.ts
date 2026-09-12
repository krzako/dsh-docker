import fs from "node:fs/promises";
import path from "node:path";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

import { config } from "../config.js";
import type { ProxySource } from "../conversations/types.js";

export type ProxyLogLevel = "none" | "error" | "warning" | "info" | "debug" | "all";
export type LogSource = ProxySource | "unknown";

const priorities: Record<ProxyLogLevel, number> = {
    none: 0,
    error: 1,
    warning: 2,
    info: 3,
    debug: 4,
    all: 5,
};

function safeHeaders(headers: IncomingHttpHeaders | Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [
            key,
            /authorization|cookie|set-cookie|proxy-authorization/i.test(key) ? "[REDACTED]" : value,
        ]),
    );
}

function safeName(source: LogSource): string {
    return source.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
}

function timestamp(): string {
    return new Date().toISOString().replaceAll(":", "-");
}

export class ProxyLogger {
    #write: Promise<void> = Promise.resolve();
    #sequence = 0;

    #enabled(level: ProxyLogLevel): boolean {
        return priorities[config.proxyLogLevel] >= priorities[level] && config.proxyLogLevel !== "none";
    }

    async log(level: ProxyLogLevel, message: string, details?: Record<string, unknown>): Promise<void> {
        if (!this.#enabled(level)) return;
        const entry = {
            timestamp: new Date().toISOString(),
            level,
            message,
            ...(details ? { details } : {}),
        };
        await this.#enqueue(async () => {
            await fs.mkdir(config.proxyLogDir, { recursive: true });
            await fs.appendFile(
                path.join(config.proxyLogDir, "copilot-proxy.log"),
                `${JSON.stringify(entry)}\n`,
                "utf8",
            );
        });
    }

    async recordRequest(
        source: LogSource,
        req: IncomingMessage,
        inputBody: unknown,
        outputHeaders: Record<string, unknown>,
        outputBody: unknown,
    ): Promise<void> {
        if (!config.proxyLogRequests) return;
        const directory = path.join(config.proxyLogDir, safeName(source));
        const date = `${timestamp()}-${String(++this.#sequence).padStart(4, "0")}`;
        await this.#enqueue(async () => {
            await fs.mkdir(directory, { recursive: true });
            await Promise.all([
                fs.writeFile(
                    path.join(directory, `${date}_input_headers.json`),
                    JSON.stringify(safeHeaders(req.headers), null, 2),
                    "utf8",
                ),
                fs.writeFile(
                    path.join(directory, `${date}_input_body.json`),
                    JSON.stringify(inputBody, null, 2),
                    "utf8",
                ),
                fs.writeFile(
                    path.join(directory, `${date}_output_headers.json`),
                    JSON.stringify(outputHeaders, null, 2),
                    "utf8",
                ),
                fs.writeFile(
                    path.join(directory, `${date}_output_body.json`),
                    JSON.stringify(outputBody, null, 2),
                    "utf8",
                ),
            ]);
        });
        await this.log("info", "request captured", { source });
    }

    async #enqueue(operation: () => Promise<void>): Promise<void> {
        this.#write = this.#write.then(operation);
        await this.#write;
    }
}

export const proxyLogger = new ProxyLogger();
