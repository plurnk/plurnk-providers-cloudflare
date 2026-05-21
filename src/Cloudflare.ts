import { encode as encodeCl100k } from "gpt-tokenizer/encoding/cl100k_base";
import llamaTokenizer from "llama-tokenizer-js";
import { chatCompletionStream, OpenAiHttpError } from "./openaiStream.ts";

const DEFAULT_FETCH_TIMEOUT_MS = 600000;
const CF_API_ROOT = "https://api.cloudflare.com/client/v4";

// Tokenizer dispatch on the Cloudflare model's @cf/{publisher}/{name} prefix.
// The publisher segment tells us which upstream family we're hitting; the
// dispatch table maps it to a sync tokenizer. Open-weight Chinese/European
// publishers (deepseek, moonshotai, google/gemma) fall through to the
// heuristic — per-family wiring (gpt2 BPE for qwen, sentencepiece for
// gemma) is later work.
type TokenizerKind = "cl100k" | "llama" | "heuristic";

const TOKENIZER_BY_PUBLISHER: ReadonlyMap<string, TokenizerKind> = new Map([
    ["openai", "cl100k"],           // @cf/openai/gpt-oss-* (uses cl100k_base)
    ["meta", "llama"],              // @cf/meta/llama-*
    ["mistral", "llama"],           // @cf/mistral/mistral-* (BPE family approximation)
]);

// Cloudflare model ids are "@cf/{publisher}/{model}". Strip the @cf prefix
// and take the second segment as publisher.
const tokenizerForModel = (model: string): TokenizerKind => {
    const segments = model.split("/");
    const publisher = segments[0] === "@cf" && segments.length >= 2 ? segments[1] : undefined;
    return publisher !== undefined ? TOKENIZER_BY_PUBLISHER.get(publisher) ?? "heuristic" : "heuristic";
};

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ProviderUsage = {
    prompt: number;
    completion: number;
    cached: number;
    total: number;
};

export type ProviderAssistant = {
    content: string;
    reasoning: string | null;
    usage: ProviderUsage;
    finishReason: string | null;
    model: string;
};

export type ProviderResponse = {
    assistant: ProviderAssistant;
    assistantRaw: unknown;
};

// Cloudflare exposes prompt and completion rates per model. No documented
// cached rate at the relay; cached portion mirrors prompt rate.
export type CloudflarePricing = {
    prompt_pico_per_token: number;
    completion_pico_per_token: number;
    cached_pico_per_token: number;
};

export type CloudflareConfig = {
    accountId: string;
    apiToken: string;
    model: string;
    contextSize: number;
    fetchTimeoutMs: number;
    pricing: CloudflarePricing;
    tokenizer: TokenizerKind;
};

export default class Cloudflare {
    #accountId: string;
    #apiToken: string;
    #model: string;
    #contextSize: number;
    #fetchTimeoutMs: number;
    #pricing: CloudflarePricing;
    #tokenizer: TokenizerKind;

    constructor(config: CloudflareConfig) {
        this.#accountId = config.accountId;
        this.#apiToken = config.apiToken;
        this.#model = config.model;
        this.#contextSize = config.contextSize;
        this.#fetchTimeoutMs = config.fetchTimeoutMs;
        this.#pricing = config.pricing;
        this.#tokenizer = config.tokenizer;
    }

    static async fromEnv(env: NodeJS.ProcessEnv, model: string): Promise<Cloudflare> {
        const accountId = env.CLOUDFLARE_ACCOUNT_ID;
        if (accountId === undefined || accountId.length === 0) {
            throw new Error("cloudflare provider: CLOUDFLARE_ACCOUNT_ID must be set");
        }
        const apiToken = env.CLOUDFLARE_API_TOKEN;
        if (apiToken === undefined || apiToken.length === 0) {
            throw new Error("cloudflare provider: CLOUDFLARE_API_TOKEN must be set");
        }
        const fetchTimeoutMs = env.PLURNK_PROVIDER_FETCH_TIMEOUT !== undefined && env.PLURNK_PROVIDER_FETCH_TIMEOUT.length > 0
            ? Number(env.PLURNK_PROVIDER_FETCH_TIMEOUT)
            : DEFAULT_FETCH_TIMEOUT_MS;
        const info = await fetchModelInfo({ accountId, apiToken, model, fetchTimeoutMs });
        return new Cloudflare({
            accountId, apiToken, model,
            contextSize: info.contextSize,
            fetchTimeoutMs,
            pricing: info.pricing,
            tokenizer: tokenizerForModel(model),
        });
    }

    get contextSize(): number { return this.#contextSize; }
    get model(): string { return this.#model; }
    get accountId(): string { return this.#accountId; }
    get pricing(): CloudflarePricing { return this.#pricing; }

    // Per-publisher dispatch, decided once from the model id's @cf/{pub}
    // prefix and frozen on the instance.
    countTokens(text: string): number {
        if (text.length === 0) return 0;
        switch (this.#tokenizer) {
            case "cl100k": return encodeCl100k(text).length;
            case "llama":  return llamaTokenizer.encode(text).length;
            case "heuristic": return Math.ceil(text.length / 4);
        }
    }

    get tokenizer(): TokenizerKind { return this.#tokenizer; }

    // Cached tokens mirror prompt rate (no separate cached rate at the relay).
    costFor(usage: ProviderUsage): number {
        const promptCost = usage.prompt * this.#pricing.prompt_pico_per_token;
        const completionCost = usage.completion * this.#pricing.completion_pico_per_token;
        return Math.round(promptCost + completionCost);
    }

    async generate({ messages, signal }: { messages: ChatMessage[]; signal?: AbortSignal }): Promise<ProviderResponse> {
        const url = `${CF_API_ROOT}/accounts/${this.#accountId}/ai/v1/chat/completions`;
        const headers: Record<string, string> = {
            Authorization: `Bearer ${this.#apiToken}`,
        };
        const body: Record<string, unknown> = { model: this.#model, messages };
        // Workers AI has no documented reasoning-toggle body param.
        // Reasoning-capable models (DeepSeek R1 distills) emit
        // reasoning_content deltas natively without a toggle. PLURNK_REASON
        // is intentionally ignored here.

        const timeoutSignal = AbortSignal.timeout(this.#fetchTimeoutMs);
        const effectiveSignal = signal !== undefined ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

        const raw = await chatCompletionStream({ url, headers, body, signal: effectiveSignal });

        const usage: ProviderUsage = {
            prompt: raw.usage?.prompt_tokens ?? 0,
            completion: raw.usage?.completion_tokens ?? 0,
            cached: raw.usage?.cached_tokens ?? 0,
            total: raw.usage?.total_tokens ?? 0,
        };

        return {
            assistant: {
                content: raw.content,
                reasoning: raw.reasoning_content.length > 0 ? raw.reasoning_content : null,
                usage,
                finishReason: raw.finish_reason,
                model: raw.model ?? this.#model,
            },
            assistantRaw: raw,
        };
    }
}

// Cloudflare's /models/search response shape:
//   { result: [{ name, properties: [{ property_id, value }, ...], ... }], success: true, ... }
// `value` for `context_window` is a string ("128000"); for `price` it's an
// array of { unit, price, currency } objects. Other property_ids (vision,
// function_calling, reasoning) are surfaced as strings or arrays — ignored.
type CfPriceEntry = { unit: string; price: number; currency: string };
type CfProperty = { property_id: string; value: string | CfPriceEntry[] };
type CfModelEntry = { name: string; properties?: CfProperty[] };
type CfSearchResponse = { result?: CfModelEntry[]; success?: boolean };

const fetchModelInfo = async ({
    accountId, apiToken, model, fetchTimeoutMs,
}: { accountId: string; apiToken: string; model: string; fetchTimeoutMs: number }): Promise<{ contextSize: number; pricing: CloudflarePricing }> => {
    const url = `${CF_API_ROOT}/accounts/${accountId}/ai/models/search?search=${encodeURIComponent(model)}`;
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiToken}` },
        signal: AbortSignal.timeout(fetchTimeoutMs),
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Cloudflare /ai/models/search returned ${res.status}: ${body}`);
    }
    const data = (await res.json()) as CfSearchResponse;
    const entry = data.result?.find((m) => m.name === model);
    if (entry === undefined) {
        throw new Error(`Cloudflare /ai/models/search has no entry matching "${model}" exactly`);
    }
    const props = entry.properties ?? [];

    // Context window. Prefer context_window; fall back to max_input_tokens.
    const ctxProp = props.find((p) => p.property_id === "context_window")
        ?? props.find((p) => p.property_id === "max_input_tokens");
    const contextSize = ctxProp !== undefined && typeof ctxProp.value === "string" ? Number(ctxProp.value) : NaN;
    if (!Number.isFinite(contextSize) || contextSize <= 0) {
        throw new Error(`Cloudflare /ai/models/search has no context_window for "${model}"`);
    }

    // Pricing. value is an array of { unit, price, currency } entries.
    // Find the per-M-token rates by unit-string match.
    const priceProp = props.find((p) => p.property_id === "price");
    const priceEntries: CfPriceEntry[] = priceProp !== undefined && Array.isArray(priceProp.value) ? priceProp.value : [];
    const promptEntry = priceEntries.find((e) => e.unit === "per M input tokens");
    const completionEntry = priceEntries.find((e) => e.unit === "per M output tokens");
    // USD per 1M tokens × 1e12 pico/USD ÷ 1e6 tokens/M = price × 1e6 pico/token.
    const promptRate = promptEntry !== undefined ? promptEntry.price * 1e6 : 0;
    const completionRate = completionEntry !== undefined ? completionEntry.price * 1e6 : 0;
    return {
        contextSize,
        pricing: {
            prompt_pico_per_token: promptRate,
            completion_pico_per_token: completionRate,
            cached_pico_per_token: promptRate,
        },
    };
};

export { OpenAiHttpError };
