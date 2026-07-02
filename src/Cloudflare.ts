// Cloudflare Workers AI provider — a thin fromEnv over the shared
// OpenAICompatProvider. Cloudflare's only bespoke surface is the
// /ai/models/search probe (context window + per-token pricing) and the
// publisher-prefix tokenizer dispatch; everything else (the generate spine,
// usage mapping, reasoning translation) is the framework's. Workers AI has no
// reasoning toggle, so reasoningStyle is "none" and PLURNK_PROVIDERS_REASONING_BUDGET is ignored.

import {
    OpenAICompatProvider,
    computeCost,
    parseRequiredInt,
    reasoningBudgetFromEnv,
    providerSource,
    requireEnv,
    tokenizerByPublisher,
    tokenizerFor,
    type Provider,
    type TokenizerFamily,
} from "@plurnk/plurnk-providers";

const CF_API_ROOT = "https://api.cloudflare.com/client/v4";

// Tokenizer dispatch on the Cloudflare model's @cf/{publisher}/{name} prefix.
// The publisher is the SECOND segment, so index 1. Open-weight publishers
// (deepseek, moonshotai, google/gemma) fall through to the heuristic.
const TOKENIZER_BY_PUBLISHER: ReadonlyMap<string, TokenizerFamily> = new Map([
    ["openai", "cl100k"],   // @cf/openai/gpt-oss-* (uses cl100k_base)
    ["meta", "llama"],      // @cf/meta/llama-*
    ["mistral", "llama"],   // @cf/mistral/mistral-* (BPE family approximation)
]);

export default class Cloudflare {
    static async fromEnv(env: NodeJS.ProcessEnv, model: string): Promise<Provider> {
        // Accept the Wrangler/CLI CF_* aliases alongside the official CLOUDFLARE_* vars.
        const accountId = requireEnv(env.CLOUDFLARE_ACCOUNT_ID || env.CF_ACCOUNT_ID, "CLOUDFLARE_ACCOUNT_ID or CF_ACCOUNT_ID", "cloudflare");
        const apiToken = requireEnv(env.CLOUDFLARE_API_TOKEN || env.CF_API_TOKEN, "CLOUDFLARE_API_TOKEN or CF_API_TOKEN", "cloudflare");
        const fetchTimeoutMs = parseRequiredInt(env.PLURNK_FETCH_TIMEOUT, "PLURNK_FETCH_TIMEOUT", "cloudflare");

        const { contextSize, pricing } = await fetchModelInfo({ accountId, apiToken, model, fetchTimeoutMs });

        const family = tokenizerByPublisher(model, TOKENIZER_BY_PUBLISHER, 1);

        return new OpenAICompatProvider({
            model,
            url: `${CF_API_ROOT}/accounts/${accountId}/ai/v1/chat/completions`,
            fetchTimeoutMs,
            headers: { Authorization: `Bearer ${apiToken}` },
            contextSize,
            reasoningStyle: "none",
            reasoningBudget: reasoningBudgetFromEnv(env, "cloudflare"),
            retryAttempts: parseRequiredInt(env.PLURNK_PROVIDERS_RETRY_ATTEMPTS, "PLURNK_PROVIDERS_RETRY_ATTEMPTS", "cloudflare"),
            countTokens: tokenizerFor(family),
            // cached tokens mirror the prompt rate (no separate cached rate at the relay);
            // reasoning bills with completion at the output rate.
            costFor: (usage) =>
                computeCost(usage, { input: pricing.prompt, output: pricing.completion, cached: pricing.prompt }),
            source: providerSource("cloudflare"),
        });
    }
}

type Pricing = { prompt: number; completion: number };

// Cloudflare's /ai/models/search response shape:
//   { result: [{ name, properties: [{ property_id, value }, ...], ... }], success: true, ... }
// `value` for `context_window`/`max_input_tokens` is a numeric string; for
// `price` it's an array of { unit, price, currency } objects.
type CfPriceEntry = { unit: string; price: number; currency: string };
type CfProperty = { property_id: string; value: string | CfPriceEntry[] };
type CfModelEntry = { name: string; properties?: CfProperty[] };
type CfSearchResponse = { result?: CfModelEntry[]; success?: boolean };

const fetchModelInfo = async ({
    accountId, apiToken, model, fetchTimeoutMs,
}: { accountId: string; apiToken: string; model: string; fetchTimeoutMs: number }): Promise<{ contextSize: number; pricing: Pricing }> => {
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
    const priceProp = props.find((p) => p.property_id === "price");
    const priceEntries: CfPriceEntry[] = priceProp !== undefined && Array.isArray(priceProp.value) ? priceProp.value : [];
    const promptEntry = priceEntries.find((e) => e.unit === "per M input tokens");
    const completionEntry = priceEntries.find((e) => e.unit === "per M output tokens");
    // USD per 1M tokens × 1e12 pico/USD ÷ 1e6 tokens/M = price × 1e6 pico/token.
    const prompt = promptEntry !== undefined ? promptEntry.price * 1e6 : 0;
    const completion = completionEntry !== undefined ? completionEntry.price * 1e6 : 0;
    return { contextSize, pricing: { prompt, completion } };
};
