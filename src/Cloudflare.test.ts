import test, { mock } from "node:test";
import assert from "node:assert/strict";
import Cloudflare from "./Cloudflare.ts";

// Minimum env that satisfies all required guards in fromEnv. Tests that need
// to exercise one specific knob override its key on top of this.
const baseEnv = Object.freeze({
    CLOUDFLARE_ACCOUNT_ID: "acc-123",
    CLOUDFLARE_API_TOKEN: "tok-abc",
    PLURNK_FETCH_TIMEOUT: "600000",
});

// Mock the /ai/models/search probe. `entry` becomes the single result row.
const mockSearch = (entry: unknown) => {
    const calls: string[] = [];
    mock.method(globalThis, "fetch", async (url: string) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ result: [entry], success: true }), { status: 200 });
    });
    return calls;
};
test.afterEach(() => mock.restoreAll());

const gptOss = {
    name: "@cf/openai/gpt-oss-120b",
    properties: [
        { property_id: "context_window", value: "131072" },
        { property_id: "price", value: [
            { unit: "per M input tokens", price: 0.011, currency: "USD" },
            { unit: "per M output tokens", price: 0.011, currency: "USD" },
        ] },
    ],
};

// — fromEnv env guards —

test("fromEnv: throws when CLOUDFLARE_ACCOUNT_ID is unset", async () => {
    await assert.rejects(
        () => Cloudflare.fromEnv({}, "@cf/openai/gpt-oss-120b"),
        /CLOUDFLARE_ACCOUNT_ID must be set/,
    );
});

test("fromEnv: throws when CLOUDFLARE_API_TOKEN is unset", async () => {
    await assert.rejects(
        () => Cloudflare.fromEnv({ CLOUDFLARE_ACCOUNT_ID: "acc-123" }, "@cf/openai/gpt-oss-120b"),
        /CLOUDFLARE_API_TOKEN must be set/,
    );
});

test("fromEnv: throws when PLURNK_FETCH_TIMEOUT is unset", async () => {
    await assert.rejects(
        () => Cloudflare.fromEnv(
            { CLOUDFLARE_ACCOUNT_ID: "acc-123", CLOUDFLARE_API_TOKEN: "tok-abc" },
            "@cf/openai/gpt-oss-120b",
        ),
        /PLURNK_FETCH_TIMEOUT must be set/,
    );
});

test("fromEnv: throws when PLURNK_FETCH_TIMEOUT is non-numeric", async () => {
    await assert.rejects(
        () => Cloudflare.fromEnv({ ...baseEnv, PLURNK_FETCH_TIMEOUT: "abc" }, "@cf/openai/gpt-oss-120b"),
        /PLURNK_FETCH_TIMEOUT must be a number/,
    );
});

// — search probe —

test("fromEnv: resolves contextSize from /ai/models/search and hits the search URL", async () => {
    const calls = mockSearch(gptOss);
    const p = await Cloudflare.fromEnv({ ...baseEnv }, "@cf/openai/gpt-oss-120b");
    assert.equal(p.model, "@cf/openai/gpt-oss-120b");
    assert.equal(p.contextSize, 131072);
    assert.equal(
        calls[0],
        "https://api.cloudflare.com/client/v4/accounts/acc-123/ai/models/search?search=%40cf%2Fopenai%2Fgpt-oss-120b",
    );
});

test("fromEnv: falls back to max_input_tokens when context_window absent", async () => {
    mockSearch({
        name: "@cf/some/model",
        properties: [
            { property_id: "max_input_tokens", value: "32768" },
            { property_id: "price", value: [
                { unit: "per M input tokens", price: 1, currency: "USD" },
                { unit: "per M output tokens", price: 2, currency: "USD" },
            ] },
        ],
    });
    const p = await Cloudflare.fromEnv({ ...baseEnv }, "@cf/some/model");
    assert.equal(p.contextSize, 32768);
});

test("fromEnv: throws when model not in search result exactly", async () => {
    mockSearch({ name: "@cf/some/other-model", properties: [] });
    await assert.rejects(
        () => Cloudflare.fromEnv({ ...baseEnv }, "@cf/missing/model"),
        /no entry matching "@cf\/missing\/model" exactly/,
    );
});

test("fromEnv: throws when search returns non-2xx", async () => {
    mock.method(globalThis, "fetch", async () => new Response("forbidden", { status: 403 }));
    await assert.rejects(
        () => Cloudflare.fromEnv({ ...baseEnv }, "@cf/x/y"),
        /\/ai\/models\/search returned 403/,
    );
});

// — Provider surface on the constructed instance —

test("costFor: prompt+completion pico-per-token math from search rates", async () => {
    // $0.011/M = 0.011 × 1e6 = 11_000 pico/token for both prompt and completion.
    mockSearch(gptOss);
    const p = await Cloudflare.fromEnv({ ...baseEnv }, "@cf/openai/gpt-oss-120b");
    // 1000 × 11_000 + 100 × 11_000 = 11_000_000 + 1_100_000 = 12_100_000
    assert.equal(p.costFor({ prompt: 1000, completion: 100, cached: 0, total: 1100 }), 12_100_000);
});

test("costFor: returns 0 when the model has no price rates", async () => {
    mockSearch({ name: "@cf/free/model", properties: [{ property_id: "context_window", value: "8192" }] });
    const p = await Cloudflare.fromEnv({ ...baseEnv }, "@cf/free/model");
    assert.equal(p.costFor({ prompt: 1000, completion: 500, cached: 0, total: 1500 }), 0);
});

test("pricing parse: USD per M tokens × 1e6 = pico per token", async () => {
    mockSearch({
        name: "@cf/test/model",
        properties: [
            { property_id: "context_window", value: "8192" },
            { property_id: "price", value: [
                { unit: "per M input tokens", price: 0.5, currency: "USD" },
                { unit: "per M output tokens", price: 1.0, currency: "USD" },
            ] },
        ],
    });
    const p = await Cloudflare.fromEnv({ ...baseEnv }, "@cf/test/model");
    // $0.50/M → 500_000 pico/token; $1.00/M → 1_000_000 pico/token.
    assert.equal(p.costFor({ prompt: 1, completion: 0, cached: 0, total: 1 }), 500_000);
    assert.equal(p.costFor({ prompt: 0, completion: 1, cached: 0, total: 1 }), 1_000_000);
});

test("tokenizer dispatch: @cf/openai/* → cl100k (hello world = 2)", async () => {
    mockSearch(gptOss);
    const p = await Cloudflare.fromEnv({ ...baseEnv }, "@cf/openai/gpt-oss-120b");
    assert.equal(p.countTokens("hello world"), 2);
});

test("tokenizer dispatch: @cf/meta/* → llama (hello world = 3)", async () => {
    mockSearch({
        name: "@cf/meta/llama-3-8b-instruct",
        properties: [{ property_id: "context_window", value: "8192" }],
    });
    const p = await Cloudflare.fromEnv({ ...baseEnv }, "@cf/meta/llama-3-8b-instruct");
    assert.equal(p.countTokens("hello world"), 3);
});

test("tokenizer dispatch: unknown publisher → heuristic", async () => {
    mockSearch({
        name: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
        properties: [{ property_id: "context_window", value: "131072" }],
    });
    const p = await Cloudflare.fromEnv({ ...baseEnv }, "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b");
    assert.equal(p.countTokens(""), 0);
    assert.equal(p.countTokens("abcde"), 2); // ceil(5/4)
});
