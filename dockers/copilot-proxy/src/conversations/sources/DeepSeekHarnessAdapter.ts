import type { SourceAdapter, SourceContext } from "../sourceAdapter.js";
import { assign, field, header } from "../sourceAdapter.js";
import type { ExternalIdentifiers } from "../types.js";

export const deepSeekHarnessAdapter: SourceAdapter = {
    source: "deepseek-harness",
    matches({ request }: SourceContext): boolean {
        return Boolean(
            field(request, "conversation_id") ||
            field(request, "deepseek_conversation_id") ||
            field(request, "thread_id"),
        );
    },
    extract({ req, request }: SourceContext): ExternalIdentifiers {
        const result: ExternalIdentifiers = {};
        assign(result, "deepseek_conversation_id", field(request, "conversation_id"));
        assign(result, "deepseek_session_id", field(request, "session_id") ?? header(req, "x-session-id"));
        assign(result, "deepseek_thread_id", field(request, "thread_id"));
        assign(result, "external_message_id", field(request, "message_id"));
        assign(result, "run_id", field(request, "run_id"));
        return result;
    },
};
