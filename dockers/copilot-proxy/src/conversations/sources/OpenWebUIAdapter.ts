import type { SourceAdapter, SourceContext } from "../sourceAdapter.js";
import { assign, field, header } from "../sourceAdapter.js";
import type { ExternalIdentifiers } from "../types.js";

export const openWebUIAdapter: SourceAdapter = {
    source: "open-webui",
    matches({ req, request }: SourceContext): boolean {
        const userAgent = header(req, "user-agent")?.toLowerCase() ?? "";
        return Boolean(
            field(request, "chat_id") ||
            field(request, "openwebui_chat_id") ||
            (userAgent.includes("python/") && userAgent.includes("aiohttp/")),
        );
    },
    extract({ request }: SourceContext): ExternalIdentifiers {
        const result: ExternalIdentifiers = {};
        assign(result, "openwebui_chat_id", field(request, "chat_id") ?? field(request, "openwebui_chat_id"));
        assign(result, "openwebui_session_id", field(request, "session_id") ?? field(request, "openwebui_session_id"));
        assign(result, "external_message_id", field(request, "message_id"));
        return result;
    },
};
