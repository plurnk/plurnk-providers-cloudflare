// Cloudflare Workers AI provider — a thin fromEnv over the shared
// OpenAICompatProvider. Cloudflare's only bespoke surface is the
// /ai/models/search probe (context window + per-token pricing) and the
// publisher-prefix tokenizer dispatch; everything else (the generate spine,
// usage mapping, reasoning translation) is the framework's. Workers AI has no
// reasoning toggle, so reasoningStyle is "none" and PLURNK_PROVIDERS_THINKING is ignored.

import {
    OpenAICompatProvider,
    computeCost,
    parseRequiredInt,
    reasoningFromEnv,
    dataCaptureFromEnv,
    parseRequiredFloat,
    providerSource,
    requireEnv,
    type Provider,
    envelopeFromEnv,
} from "@plurnk/plurnk-providers";

const PICO_USD_PER_USD = 1_000_000_000_000;
const TOKENS_PER_MILLION = 1_000_000;
const picoPerToken = (usdPerMillion: number): number =>
    usdPerMillion * PICO_USD_PER_USD / TOKENS_PER_MILLION;

// Tokenizer dispatch on the Cloudflare model's @cf/{publisher}/{name} prefix.
// The publisher is the SECOND segment, so index 1. Open-weight publishers
// (deepseek, moonshotai, google/gemma) fall through to the heuristic.
export default class Cloudflare {
    static async fromEnv(env: NodeJS.ProcessEnv, model: string): Promise<Provider> {
        // Accept the Wrangler/CLI CF_* aliases alongside the official CLOUDFLARE_* vars.
        const accountId = requireEnv(env.CLOUDFLARE_ACCOUNT_ID || env.CF_ACCOUNT_ID, "CLOUDFLARE_ACCOUNT_ID or CF_ACCOUNT_ID", "cloudflare");
        const apiToken = requireEnv(env.CLOUDFLARE_API_TOKEN || env.CF_API_TOKEN, "CLOUDFLARE_API_TOKEN or CF_API_TOKEN", "cloudflare");
        const baseUrl = requireEnv(env.CLOUDFLARE_BASE_URL, "CLOUDFLARE_BASE_URL", "cloudflare").replace(/\/+$/, "");
        const unifiedModels = parseUnifiedModels(requireEnv(env.CLOUDFLARE_UNIFIED_MODELS, "CLOUDFLARE_UNIFIED_MODELS", "cloudflare"));
        const fetchTimeoutMs = parseRequiredInt(env.PLURNK_PROVIDERS_FETCH_TIMEOUT, "PLURNK_PROVIDERS_FETCH_TIMEOUT", "cloudflare");

        const { contextWindow, pricing } = await fetchModelInfo({ baseUrl, accountId, apiToken, model, fetchTimeoutMs, unifiedModels });

        return new OpenAICompatProvider({
            model,
            url: `${baseUrl}/accounts/${accountId}/ai/v1/chat/completions`,
            fetchTimeoutMs,
            headers: { Authorization: `Bearer ${apiToken}` },
            contextWindow,
            reasoningStyle: "none",
            temperature: parseRequiredFloat(env.PLURNK_PROVIDERS_TEMPERATURE, "PLURNK_PROVIDERS_TEMPERATURE", "cloudflare", 0),
            repeatPenalty: parseRequiredFloat(env.PLURNK_PROVIDERS_REPEAT_PENALTY, "PLURNK_PROVIDERS_REPEAT_PENALTY", "cloudflare", 0),
            frequencyPenalty: parseRequiredFloat(env.PLURNK_PROVIDERS_FREQUENCY_PENALTY, "PLURNK_PROVIDERS_FREQUENCY_PENALTY", "cloudflare", 0),
            // #507: envelope reserves (window-fraction floor, absolute overrides).
            ...envelopeFromEnv(env, "cloudflare"),
            retryDelayMs: parseRequiredInt(env.PLURNK_PROVIDERS_RETRY_DELAY, "PLURNK_PROVIDERS_RETRY_DELAY", "cloudflare"),
            reasoning: reasoningFromEnv(env, "cloudflare"),
            retryAttempts: parseRequiredInt(env.PLURNK_PROVIDERS_RETRY_ATTEMPTS, "PLURNK_PROVIDERS_RETRY_ATTEMPTS", "cloudflare"),
            // Opt-in data capture (#36), off by default, per-alias-scopable.
            ...dataCaptureFromEnv(env, "cloudflare"),
            // cached tokens mirror the prompt rate (no separate cached rate at the relay);
            // reasoning bills with completion at the output rate.
            costFor: (usage) =>
                computeCost(usage, { input: pricing.prompt, output: pricing.completion, cached: pricing.cached }),
            source: providerSource("cloudflare"),
        });
    }
}

type Pricing = { prompt: number; cached: number; completion: number };
type UnifiedModel = {
    contextWindow: number;
    inputPerMillion: number;
    cachedInputPerMillion: number;
    outputPerMillion: number;
};
type UnifiedModels = Readonly<Record<string, UnifiedModel>>;

// Cloudflare's /ai/models/search response shape:
//   { result: [{ name, properties: [{ property_id, value }, ...], ... }], success: true, ... }
// `value` for `context_window`/`max_input_tokens` is a numeric string; for
// `price` it's an array of { unit, price, currency } objects.
type CfPriceEntry = { unit: string; price: number; currency: string };
type CfProperty = { property_id: string; value: string | CfPriceEntry[] };
type CfModelEntry = { name: string; properties?: CfProperty[] };
type CfSearchResponse = { result?: CfModelEntry[]; success?: boolean };

const fetchModelInfo = async ({
    baseUrl, accountId, apiToken, model, fetchTimeoutMs, unifiedModels,
}: { baseUrl: string; accountId: string; apiToken: string; model: string; fetchTimeoutMs: number; unifiedModels: UnifiedModels }): Promise<{ contextWindow: number; pricing: Pricing }> => {
    const url = `${baseUrl}/accounts/${accountId}/ai/models/search?search=${encodeURIComponent(model)}`;
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
        if (!model.startsWith("@cf/")) return unifiedModelInfo(model, unifiedModels);
        throw new Error(`Cloudflare /ai/models/search has no entry matching "${model}" exactly`);
    }
    const props = entry.properties ?? [];

    // Context window. Prefer context_window; fall back to max_input_tokens.
    const ctxProp = props.find((p) => p.property_id === "context_window")
        ?? props.find((p) => p.property_id === "max_input_tokens");
    const contextWindow = ctxProp !== undefined && typeof ctxProp.value === "string" ? Number(ctxProp.value) : NaN;
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
        throw new Error(`Cloudflare /ai/models/search has no context_window for "${model}"`);
    }

    // Pricing. value is an array of { unit, price, currency } entries.
    const priceProp = props.find((p) => p.property_id === "price");
    const priceEntries: CfPriceEntry[] = priceProp !== undefined && Array.isArray(priceProp.value) ? priceProp.value : [];
    const promptEntry = priceEntries.find((e) => e.unit === "per M input tokens");
    const cachedEntry = priceEntries.find((e) => e.unit === "per M cached input tokens");
    const completionEntry = priceEntries.find((e) => e.unit === "per M output tokens");
    // USD per 1M tokens × 1e12 pico/USD ÷ 1e6 tokens/M = price × 1e6 pico/token.
    const prompt = promptEntry !== undefined ? picoPerToken(promptEntry.price) : 0;
    const cached = cachedEntry !== undefined ? picoPerToken(cachedEntry.price) : prompt;
    const completion = completionEntry !== undefined ? picoPerToken(completionEntry.price) : 0;
    return { contextWindow, pricing: { prompt, cached, completion } };
};

const isFiniteNonNegative = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;

const parseUnifiedModels = (raw: string): UnifiedModels => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (cause) {
        throw new Error("cloudflare provider: CLOUDFLARE_UNIFIED_MODELS must be valid JSON", { cause });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("cloudflare provider: CLOUDFLARE_UNIFIED_MODELS must be a JSON object");
    }
    for (const [model, value] of Object.entries(parsed)) {
        if (
            value === null
            || typeof value !== "object"
            || Array.isArray(value)
            || !Number.isInteger((value as UnifiedModel).contextWindow)
            || (value as UnifiedModel).contextWindow <= 0
            || !isFiniteNonNegative((value as UnifiedModel).inputPerMillion)
            || !isFiniteNonNegative((value as UnifiedModel).cachedInputPerMillion)
            || !isFiniteNonNegative((value as UnifiedModel).outputPerMillion)
        ) {
            throw new Error(`cloudflare provider: CLOUDFLARE_UNIFIED_MODELS has invalid metadata for "${model}"`);
        }
    }
    return parsed as UnifiedModels;
};

// Cloudflare omits some documented Unified routes from /ai/models/search.
// Their explicit shipped catalog is the source of truth; a miss remains fatal.
const unifiedModelInfo = (model: string, unifiedModels: UnifiedModels): { contextWindow: number; pricing: Pricing } => {
    const info = unifiedModels[model];
    if (info === undefined) {
        throw new Error(`Cloudflare Unified model "${model}" is absent from CLOUDFLARE_UNIFIED_MODELS`);
    }
    return {
        contextWindow: info.contextWindow,
        pricing: {
            prompt: picoPerToken(info.inputPerMillion),
            cached: picoPerToken(info.cachedInputPerMillion),
            completion: picoPerToken(info.outputPerMillion),
        },
    };
};
