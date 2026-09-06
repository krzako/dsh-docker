export type OpenAIRole = "system" | "developer" | "user" | "assistant" | "tool";

export type TextContentPart = {
    type: "text";
    text: string;
};

export type ImageUrlContentPart = {
    type: "image_url";
    image_url: {
        url: string;
        detail?: "auto" | "low" | "high";
    };
};

export type MessageContent = string | Array<TextContentPart | ImageUrlContentPart> | null;

export type OpenAIToolCall = {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
};

export type OpenAIChatMessage = {
    role: OpenAIRole;
    content?: MessageContent;
    name?: string;
    tool_call_id?: string;
    tool_calls?: OpenAIToolCall[];
};

export type OpenAIFunctionTool = {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
        strict?: boolean;
    };
};

export type OpenAIToolChoice =
    | "none"
    | "auto"
    | "required"
    | {
          type: "function";
          function: { name: string };
      };

export type ChatCompletionRequest = {
    model: string;
    messages: OpenAIChatMessage[];
    stream?: boolean;
    stream_options?: { include_usage?: boolean };
    tools?: OpenAIFunctionTool[];
    tool_choice?: OpenAIToolChoice;
    parallel_tool_calls?: boolean;
    reasoning_effort?: "low" | "medium" | "high" | "xhigh";
    response_format?:
        | { type: "text" }
        | { type: "json_object" }
        | { type: "json_schema"; json_schema: Record<string, unknown> };
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    max_completion_tokens?: number;
    n?: number;
    stop?: string | string[];
    user?: string;
};

export type ProxyToolCall = {
    id: string;
    name: string;
    arguments: Record<string, unknown> | unknown;
};

export type ProxyUsage = {
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    totalNanoAiu?: number;
    aiCredits?: number;
    premiumRequestCost?: number;
};
