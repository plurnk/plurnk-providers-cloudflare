import test, { mock } from "node:test";
import assert from "node:assert/strict";
import Cloudflare from "./Cloudflare.ts";

// Minimum env that satisfies all required guards in fromEnv. Tests that need
// to exercise one specific knob override its key on top of this.
const baseEnv = Object.freeze({
    CLOUDFLARE_ACCOUNT_ID: "acc-123",
    CLOUDFLARE_API_TOKEN: "tok-abc",
    PLURNK_PROVIDERS_FETCH_TIMEOUT: "600000",
    PLURNK_PROVIDERS_REASONING: "off", PLURNK_PROVIDERS_TEMPERATURE: "0.2", PLURNK_PROVIDERS_REPEAT_PENALTY: "1.15", PLURNK_PROVIDERS_FREQUENCY_PENALTY: "0.4", PLURNK_PROVIDERS_RETRY_DELAY: "1", PLURNK_PROVIDERS_PROBE_ATTEMPTS: "3", PLURNK_PROVIDERS_PROBE_DELAY: "1",
    PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
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

test("fromEnv: throws when neither CLOUDFLARE_ACCOUNT_ID nor CF_ACCOUNT_ID is set", async () => {
    await assert.rejects(
        () => Cloudflare.fromEnv({}, "@cf/openai/gpt-oss-120b"),
        /CLOUDFLARE_ACCOUNT_ID or CF_ACCOUNT_ID must be set/,
    );
});

test("fromEnv: throws when neither CLOUDFLARE_API_TOKEN nor CF_API_TOKEN is set", async () => {
    await assert.rejects(
        () => Cloudflare.fromEnv({ CLOUDFLARE_ACCOUNT_ID: "acc-123" }, "@cf/openai/gpt-oss-120b"),
        /CLOUDFLARE_API_TOKEN or CF_API_TOKEN must be set/,
    );
});

test("fromEnv: accepts the Wrangler CF_ACCOUNT_ID / CF_API_TOKEN aliases", async () => {
    const rest = { PLURNK_PROVIDERS_FETCH_TIMEOUT: "600000", PLURNK_PROVIDERS_REASONING: "off", PLURNK_PROVIDERS_TEMPERATURE: "0.2", PLURNK_PROVIDERS_REPEAT_PENALTY: "1.15", PLURNK_PROVIDERS_FREQUENCY_PENALTY: "0.4", PLURNK_PROVIDERS_RETRY_DELAY: "1", PLURNK_PROVIDERS_PROBE_ATTEMPTS: "3", PLURNK_PROVIDERS_PROBE_DELAY: "1", PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0" };
    const calls = mockSearch(gptOss);
    await Cloudflare.fromEnv({ ...rest, CF_ACCOUNT_ID: "acc-cf", CF_API_TOKEN: "tok-cf" }, "@cf/openai/gpt-oss-120b");
    assert.ok(calls.some((u) => u.includes("/accounts/acc-cf/")), `CF_ACCOUNT_ID alias used: ${calls[0]}`);
});

test("fromEnv: throws when PLURNK_PROVIDERS_FETCH_TIMEOUT is unset", async () => {
    await assert.rejects(
        () => Cloudflare.fromEnv(
            { CLOUDFLARE_ACCOUNT_ID: "acc-123", CLOUDFLARE_API_TOKEN: "tok-abc" },
            "@cf/openai/gpt-oss-120b",
        ),
        /PLURNK_PROVIDERS_FETCH_TIMEOUT must be set/,
    );
});

test("fromEnv: throws when PLURNK_PROVIDERS_FETCH_TIMEOUT is non-numeric", async () => {
    await assert.rejects(
        () => Cloudflare.fromEnv({ ...baseEnv, PLURNK_PROVIDERS_FETCH_TIMEOUT: "abc" }, "@cf/openai/gpt-oss-120b"),
        /PLURNK_PROVIDERS_FETCH_TIMEOUT must be a non-negative integer/,
    );
});

test("generate failure carries the provider:cloudflare telemetry source (SPEC §12)", async () => {
    const { ProviderError } = await import("@plurnk/plurnk-providers");
    mock.method(globalThis, "fetch", async (url: string) => {
        if (String(url).includes("/ai/models/search")) {
            return new Response(JSON.stringify({ result: [gptOss], success: true }), { status: 200 });
        }
        return new Response("rate limited", { status: 429 });
    });
    const p = await Cloudflare.fromEnv({ ...baseEnv }, "@cf/openai/gpt-oss-120b");
    await assert.rejects(() => p.generate({ runId: "r", messages: [] }), (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.kind, "rate_limit");
        assert.equal(err.toTelemetryEvent().source, "provider:cloudflare");
        return true;
    });
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
    assert.equal(p.costFor({ prompt: 1000, completion: 100, reasoning: 0, cached: 0, total: 1100 }), 12_100_000);
});

test("costFor: reasoning bills at the completion rate", async () => {
    // Same $0.011/M = 11_000 pico/token rates from gptOss.
    mockSearch(gptOss);
    const p = await Cloudflare.fromEnv({ ...baseEnv }, "@cf/openai/gpt-oss-120b");
    // (completion 100 + reasoning 50) × 11_000 = 1_650_000; prompt 1000 × 11_000 = 11_000_000.
    assert.equal(
        p.costFor({ prompt: 1000, completion: 100, reasoning: 50, cached: 0, total: 1150 }),
        12_650_000,
    );
});

test("costFor: returns 0 when the model has no price rates", async () => {
    mockSearch({ name: "@cf/free/model", properties: [{ property_id: "context_window", value: "8192" }] });
    const p = await Cloudflare.fromEnv({ ...baseEnv }, "@cf/free/model");
    assert.equal(p.costFor({ prompt: 1000, completion: 500, reasoning: 0, cached: 0, total: 1500 }), 0);
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
    assert.equal(p.costFor({ prompt: 1, completion: 0, reasoning: 0, cached: 0, total: 1 }), 500_000);
    assert.equal(p.costFor({ prompt: 0, completion: 1, reasoning: 0, cached: 0, total: 1 }), 1_000_000);
});

