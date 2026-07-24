# @plurnk/plurnk-providers-cloudflare

Cloudflare Workers AI provider for [plurnk-service](https://github.com/plurnk/plurnk-service). Routes Cloudflare-hosted `@cf/{publisher}/{model}` and Unified Billing `provider/model` aliases through Workers AI's OpenAI-compatible chat-completions endpoint.

## install

```
npm install @plurnk/plurnk-providers-cloudflare
```

Requires Node ≥ 25 (native TypeScript).

## use

```ts
import Cloudflare from "@plurnk/plurnk-providers-cloudflare";

const provider = await Cloudflare.fromEnv(process.env, "@cf/openai/gpt-oss-120b");
```

Model aliases are used verbatim. plurnk-service's alias system resolves both `PLURNK_MODEL_<name>=cloudflare/@cf/openai/gpt-oss-120b` and `PLURNK_MODEL_<name>=cloudflare/moonshotai/kimi-k3` cleanly because the first slash terminates `provider=cloudflare`.

## env

No fallback defaults — required vars throw at `fromEnv` if missing or unparseable. Defaults belong in `plurnk-service`'s `.env.example` cascade, not in library code.

| Variable | Required | Notes |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | yes | Workers AI endpoints are account-scoped. Alias `CF_ACCOUNT_ID` also accepted |
| `CLOUDFLARE_API_TOKEN` | yes | Bearer token with Workers AI permission. Alias `CF_API_TOKEN` also accepted |
| `PLURNK_PROVIDERS_REASONING_BUDGET` | no | Ignored — Workers AI has no documented reasoning-toggle body param. Reasoning-capable models (DeepSeek R1 distills) emit `reasoning_content` deltas natively |
| `PLURNK_PROVIDERS_FETCH_TIMEOUT` | yes | Universal fetch timeout in ms (SPEC §4) |
| `PLURNK_PROVIDERS_RETRY_ATTEMPTS` | yes | Transient-failure retry budget (SPEC §4): `0` disables; `N` retries on 429/5xx/timeout/network with exponential backoff, honoring `Retry-After`. |

## context window & pricing

For `@cf/` models, both are pulled at `fromEnv` time from `GET /accounts/{id}/ai/models/search?search={alias}`. Cloudflare's catalog response carries each model's metadata as a `properties[]` array of `{property_id, value}` entries:

- `context_window` — string value, parsed as Number for `contextSize`
- `price` — value is an array of `{unit, price, currency}` entries:
  - `"per M input tokens"` → `prompt_pico_per_token = price × 1e6`
  - `"per M cached input tokens"` → `cached_pico_per_token = price × 1e6`
  - `"per M output tokens"` → `completion_pico_per_token = price × 1e6`
  - (Math: USD per 1M tokens × 1e12 pico/USD ÷ 1e6 tokens/M = `price × 1e6` pico/token)

For Unified Billing `provider/model` IDs absent from Workers AI's model search, the provider resolves the exact native-provider row from `@plurnk/plurnk-models`. Cloudflare documents Unified Billing inference pricing as passed through without markup, making that provider-specific row authoritative. Missing context or pricing fails construction; no other provider's rate and no zero-price fallback is used. When a model has no separate cached rate, cached input mirrors ordinary input.

## tokenization

Per-publisher dispatch on the `@cf/{publisher}/{model}` prefix, decided once at `fromEnv` and frozen on the instance:

| Publisher prefix | Tokenizer |
|---|---|
| `@cf/openai/*` | `cl100k_base` (gpt-oss releases use OpenAI's tiktoken family; via [gpt-tokenizer](https://www.npmjs.com/package/gpt-tokenizer)) |
| `@cf/meta/*` | `llama` (via [llama-tokenizer-js](https://www.npmjs.com/package/llama-tokenizer-js)) |
| `@cf/mistral/*` | `llama` (BPE family approximation) |
| anything else | heuristic (~4 chars/token) |

Open-weight publishers without a sync npm tokenizer (deepseek-ai, moonshotai, google's gemma releases) fall through to the heuristic. Per-family wiring is later work.

## license

MIT.
