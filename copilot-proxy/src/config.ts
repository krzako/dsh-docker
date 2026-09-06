import os from "node:os";
import path from "node:path";

export type CopilotLogLevel = "none" | "error" | "warning" | "info" | "debug" | "all";

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
    const value = (process.env.COPILOT_LOG_LEVEL ?? "warning") as CopilotLogLevel;
    const allowed = new Set<CopilotLogLevel>(["none", "error", "warning", "info", "debug", "all"]);
    if (!allowed.has(value)) throw new Error(`Invalid COPILOT_LOG_LEVEL: ${value}`);
    return value;
}

const defaultCopilotHome = path.join(os.homedir(), ".copilot");

export const config = {
    host: process.env.HOST ?? "127.0.0.1",
    port: intEnv("PORT", 9999),
    apiKey: process.env.PROXY_API_KEY || undefined,
    githubToken: process.env.COPILOT_GITHUB_TOKEN || process.env.GITHUB_TOKEN || undefined,
    copilotRuntimeUrl: process.env.COPILOT_RUNTIME_URL || undefined,
    copilotHome: path.resolve(process.env.COPILOT_HOME || defaultCopilotHome),
    copilotLogLevel: logLevelEnv(),
    maxBodyBytes: intEnv("MAX_BODY_BYTES", 16 * 1024 * 1024),
};
