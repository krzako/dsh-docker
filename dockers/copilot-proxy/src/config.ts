export type CopilotLogLevel = "none" | "error" | "warning" | "info" | "debug" | "all";
export type ProxyLogLevel = CopilotLogLevel;

function intEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return parsed;
}

function logLevelEnv(): CopilotLogLevel {
    const value = (process.env.COPILOT_PROXY_COPILOT_SDK_LOG_LEVEL ?? "error") as CopilotLogLevel;
    const allowed = new Set<CopilotLogLevel>(["none", "error", "warning", "info", "debug", "all"]);
    if (!allowed.has(value)) throw new Error(`Invalid COPILOT_PROXY_COPILOT_SDK_LOG_LEVEL: ${value}`);
    return value;
}

function proxyLogLevelEnv(): ProxyLogLevel {
    const value = (process.env.COPILOT_PROXY_LOG_LEVEL ?? "info") as ProxyLogLevel;
    const allowed = new Set<ProxyLogLevel>(["none", "error", "warning", "info", "debug", "all"]);
    if (!allowed.has(value)) throw new Error(`Invalid COPILOT_PROXY_LOG_LEVEL: ${value}`);
    return value;
}

function boolEnv(name: string, fallback: boolean): boolean {
    const value = process.env[name];
    if (value === undefined) return fallback;
    if (value === "true" || value === "1" || value === "yes") return true;
    if (value === "false" || value === "0" || value === "no") return false;
    throw new Error(`${name} must be true or false`);
}

export const config = {
    host: process.env.COPILOT_PROXY_HOST ?? "127.0.0.1",
    port: intEnv("COPILOT_PROXY_PORT", 9091),
    apiKey: process.env.COPILOT_PROXY_API_KEY || undefined,
    copilotRuntimeUrl: "127.0.0.1:4321",
    copilotHome: "/home/node/.copilot",
    conversationStorePath:
        process.env.COPILOT_PROXY_CONVERSATION_STORE ?? "/home/node/.copilot/proxy-conversations.json",
    maxContextMessages: intEnv("COPILOT_PROXY_MAX_CONTEXT_MESSAGES", 2000),
    copilotSdkLogLevel: logLevelEnv(),
    proxyLogLevel: proxyLogLevelEnv(),
    proxyLogRequests: boolEnv("COPILOT_PROXY_LOG_REQUESTS", true),
    proxyLogDir: "/app/logs/copilot-proxy",
};
