import "dotenv/config";

import { config } from "./config.js";
import { startServer } from "./server.js";

try {
    await startServer();
    console.error(`copilot-openai-proxy listening on http://${config.host}:${config.port}`);
} catch (error) {
    console.error(error);
    process.exit(1);
}
