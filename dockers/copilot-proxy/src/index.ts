import "dotenv/config";

import { config } from "./config.js";
import { proxyLogger } from "./logging/ProxyLogger.js";
import { startServer } from "./server.js";

try {
    await startServer();
    console.error(
        `[copilot-proxy] READY http://${config.host}:${config.port} ` +
            `(POST /v1/chat/completions, GET /v1/models, GET /health)`,
    );
    await proxyLogger.log("info", "proxy started", { host: config.host, port: config.port });
} catch (error) {
    console.error(error);
    await proxyLogger.log("error", "proxy failed to start", {
        error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
}
