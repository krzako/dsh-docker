import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";

const client = new CopilotClient({
    mode: "empty",
    connection: RuntimeConnection.forUri("127.0.0.1:4321"),
    logLevel: "none",
});

try {
    await client.start();
    await client.listModels();
    process.exit(0);
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
