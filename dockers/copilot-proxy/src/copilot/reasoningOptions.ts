import type { ReasoningEffort } from "../types/openai.js";

export type CopilotReasoningSummary = "none" | "detailed";

/** Keep the requested summary independent of the model's reasoning effort. */
export function reasoningSummaryFor(effort: ReasoningEffort | undefined): CopilotReasoningSummary {
    return effort === "none" ? "none" : "detailed";
}
