import test from "node:test";
import assert from "node:assert/strict";
import Cloudflare from "./Cloudflare.ts";

const samplePricing = { prompt_pico_per_token: 350_000, completion_pico_per_token: 750_000, cached_pico_per_token: 350_000 };

const mockSearchResponse = (entry: object) => ({
    ok: true,
    json: async () => ({ result: [entry], success: true }),
});

test("fromEnv: throws when CLOUDFLARE_ACCOUNT_ID is unset", async () => {
    await assert.rejects(
        () => Cloudflare.fromEnv({}, "@cf/openai/gpt-oss-120b"),
        /CLOUDFLARE_ACCOUNT_ID must be set/,
    );
});

test("fromEnv: throws when CLOUDFLARE_API_TOKEN is unset", async () => {
    await assert.rejects(
        () => Cloudflare.fromEnv({ CLOUDFLARE_ACCOUNT_ID: "abc" }, "@cf/openai/gpt-oss-120b"),
        /CLOUDFLARE_API_TOKEN must be set/,
    );
});

test("fromEnv: resolves contextSize + pricing from /ai/models/search", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = (async () => mockSearchResponse({
        name: "@cf/openai/gpt-oss-120b",
        properties: [
            { property_id: "context_window", value: "128000" },
            { property_id: "price", value: [
                { unit: "per M input tokens", price: 0.35, currency: "USD" },
                { unit: "per M output tokens", price: 0.75, currency: "USD" },
            ] },
        ],
    })) as unknown as typeof fetch;

    const p = await Cloudflare.fromEnv({
        CLOUDFLARE_ACCOUNT_ID: "acc-123", CLOUDFLARE_API_TOKEN: "tok-abc",
    }, "@cf/openai/gpt-oss-120b");
    assert.equal(p.model, "@cf/openai/gpt-oss-120b");
    assert.equal(p.contextSize, 128_000);
    assert.deepEqual(p.pricing, samplePricing);
});

test("fromEnv: falls back to max_input_tokens when context_window absent", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = (async () => mockSearchResponse({
        name: "@cf/some/model",
        properties: [
            { property_id: "max_input_tokens", value: "32768" },
            { property_id: "price", value: [
                { unit: "per M input tokens", price: 1, currency: "USD" },
                { unit: "per M output tokens", price: 2, currency: "USD" },
            ] },
        ],
    })) as unknown as typeof fetch;

    const p = await Cloudflare.fromEnv({
        CLOUDFLARE_ACCOUNT_ID: "acc-123", CLOUDFLARE_API_TOKEN: "tok-abc",
    }, "@cf/some/model");
    assert.equal(p.contextSize, 32_768);
});

test("fromEnv: throws when model not in search result.exactly", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({ result: [{ name: "@cf/some/other-model", properties: [] }], success: true }),
    })) as unknown as typeof fetch;

    await assert.rejects(
        () => Cloudflare.fromEnv({
            CLOUDFLARE_ACCOUNT_ID: "acc-123", CLOUDFLARE_API_TOKEN: "tok-abc",
        }, "@cf/missing/model"),
        /no entry matching "@cf\/missing\/model" exactly/,
    );
});

test("fromEnv: throws when search returns non-2xx", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = (async () => ({
        ok: false,
        status: 403,
        text: async () => "forbidden",
    })) as unknown as typeof fetch;

    await assert.rejects(
        () => Cloudflare.fromEnv({
            CLOUDFLARE_ACCOUNT_ID: "acc-123", CLOUDFLARE_API_TOKEN: "tok-abc",
        }, "@cf/x/y"),
        /\/ai\/models\/search returned 403/,
    );
});

test("contextSize, model, accountId exposed on instance", () => {
    const p = new Cloudflare({
        accountId: "acc-123", apiToken: "tok", model: "@cf/openai/gpt-oss-120b",
        contextSize: 128_000, fetchTimeoutMs: 1, pricing: samplePricing, tokenizer: "heuristic",
    });
    assert.equal(p.contextSize, 128_000);
    assert.equal(p.model, "@cf/openai/gpt-oss-120b");
    assert.equal(p.accountId, "acc-123");
});

test("costFor: prompt+completion math from per-token rates", () => {
    const p = new Cloudflare({
        accountId: "x", apiToken: "y", model: "m", contextSize: 1, fetchTimeoutMs: 1,
        pricing: samplePricing, tokenizer: "heuristic",
    });
    // 1000 prompt × 350_000 + 100 completion × 750_000 = 350M + 75M = 425M pico
    assert.equal(p.costFor({ prompt: 1000, completion: 100, cached: 0, total: 1100 }), 425_000_000);
});

test("countTokens: heuristic returns 0 for empty, ceil(len/4) otherwise", () => {
    const p = new Cloudflare({
        accountId: "x", apiToken: "y", model: "m", contextSize: 1, fetchTimeoutMs: 1,
        pricing: samplePricing, tokenizer: "heuristic",
    });
    assert.equal(p.countTokens(""), 0);
    assert.equal(p.countTokens("abcd"), 1);
    assert.equal(p.countTokens("abcde"), 2);
});

test("tokenizer dispatch: @cf/openai/* → cl100k", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = (async () => mockSearchResponse({
        name: "@cf/openai/gpt-oss-120b",
        properties: [
            { property_id: "context_window", value: "128000" },
            { property_id: "price", value: [
                { unit: "per M input tokens", price: 0.35, currency: "USD" },
                { unit: "per M output tokens", price: 0.75, currency: "USD" },
            ] },
        ],
    })) as unknown as typeof fetch;

    const p = await Cloudflare.fromEnv({
        CLOUDFLARE_ACCOUNT_ID: "x", CLOUDFLARE_API_TOKEN: "y",
    }, "@cf/openai/gpt-oss-120b");
    assert.equal(p.tokenizer, "cl100k");
    assert.equal(p.countTokens("hello world"), 2);
});

test("tokenizer dispatch: @cf/meta/* → llama", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = (async () => mockSearchResponse({
        name: "@cf/meta/llama-3-8b-instruct",
        properties: [
            { property_id: "context_window", value: "8192" },
            { property_id: "price", value: [
                { unit: "per M input tokens", price: 0.282, currency: "USD" },
                { unit: "per M output tokens", price: 0.827, currency: "USD" },
            ] },
        ],
    })) as unknown as typeof fetch;

    const p = await Cloudflare.fromEnv({
        CLOUDFLARE_ACCOUNT_ID: "x", CLOUDFLARE_API_TOKEN: "y",
    }, "@cf/meta/llama-3-8b-instruct");
    assert.equal(p.tokenizer, "llama");
    assert.equal(p.countTokens("hello world"), 3);
});

test("tokenizer dispatch: unknown publisher → heuristic", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = (async () => mockSearchResponse({
        name: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
        properties: [
            { property_id: "context_window", value: "131072" },
            { property_id: "price", value: [
                { unit: "per M input tokens", price: 0.497, currency: "USD" },
                { unit: "per M output tokens", price: 4.881, currency: "USD" },
            ] },
        ],
    })) as unknown as typeof fetch;

    const p = await Cloudflare.fromEnv({
        CLOUDFLARE_ACCOUNT_ID: "x", CLOUDFLARE_API_TOKEN: "y",
    }, "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b");
    assert.equal(p.tokenizer, "heuristic");
});

test("pricing parse: USD per M tokens × 1e6 = pico per token (sanity)", async (t) => {
    // Confirms the conversion: $0.50/M = $0.0000005/token = 500_000 pico/token.
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = (async () => mockSearchResponse({
        name: "@cf/test",
        properties: [
            { property_id: "context_window", value: "8192" },
            { property_id: "price", value: [
                { unit: "per M input tokens", price: 0.5, currency: "USD" },
                { unit: "per M output tokens", price: 1.0, currency: "USD" },
            ] },
        ],
    })) as unknown as typeof fetch;
    const p = await Cloudflare.fromEnv({
        CLOUDFLARE_ACCOUNT_ID: "x", CLOUDFLARE_API_TOKEN: "y",
    }, "@cf/test");
    assert.equal(p.pricing.prompt_pico_per_token, 500_000);
    assert.equal(p.pricing.completion_pico_per_token, 1_000_000);
});
