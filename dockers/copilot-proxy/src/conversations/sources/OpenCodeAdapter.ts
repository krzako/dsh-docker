import type { SourceAdapter, SourceContext } from "../sourceAdapter.js";
import { assign, field, header, IdentifierConflictError, urlIdentifier } from "../sourceAdapter.js";
import type { ExternalIdentifiers } from "../types.js";

export const openCodeAdapter: SourceAdapter = {
    source: "opencode",
    matches({ req, request }: SourceContext): boolean {
        return Boolean(
            header(req, "x-session-id") ||
            header(req, "user-agent")?.toLowerCase().startsWith("opencode/") ||
            field(request, "opencode_session_id") ||
            urlIdentifier(req, "session"),
        );
    },
    extract({ req, request }: SourceContext): ExternalIdentifiers {
        const result: ExternalIdentifiers = {};
        const bodySession = field(request, "session_id");
        const explicitSession = field(request, "opencode_session_id");
        const urlSession = urlIdentifier(req, "session");
        const bodySessions = [bodySession, explicitSession].filter(
            (item, index, items): item is string => Boolean(item) && items.indexOf(item) === index,
        );
        if (bodySessions.length > 1 || (urlSession && bodySessions.some((item) => item !== urlSession))) {
            throw new IdentifierConflictError("OpenCode session identifiers conflict");
        }
        const headerSession = header(req, "x-session-id");
        const affinitySession = header(req, "x-session-affinity");
        assign(result, "opencode_session_id", urlSession ?? bodySession ?? explicitSession ?? headerSession);
        assign(result, "opencode_header_session_id", headerSession);
        assign(result, "opencode_affinity_session_id", affinitySession);
        assign(result, "external_message_id", field(request, "message_id"));
        if (result.opencode_session_id && headerSession && result.opencode_session_id !== headerSession) {
            throw new IdentifierConflictError(
                "OpenCode session_id conflicts with its transport session header; refusing to merge sessions",
            );
        }
        if (headerSession && affinitySession && headerSession !== affinitySession) {
            throw new IdentifierConflictError(
                "OpenCode x-session-id conflicts with x-session-affinity; refusing to merge sessions",
            );
        }
        return result;
    },
};
