# @plurnk/plurnk-providers-cloudflare

Cloudflare Workers AI provider for [plurnk-service](https://github.com/plurnk/plurnk-service). Routes `@cf/{publisher}/{model}` aliases through Workers AI's OpenAI-compatible chat-completions endpoint.

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

`@cf/{publisher}/{model}` aliases are used verbatim — Workers AI's own namespace, no prefix stripping. plurnk-service's alias system resolves `PLURNK_MODEL_<name>=cloudflare/@cf/openai/gpt-oss-120b` cleanly because the first slash terminates `provider=cloudflare`.

## env

| Variable | Required | Notes |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | yes | Workers AI endpoints are account-scoped |
| `CLOUDFLARE_API_TOKEN` | yes | Bearer token with Workers AI permission |
| `PLURNK_REASON` | no | Ignored — Workers AI has no documented reasoning-toggle body param. Reasoning-capable models (DeepSeek R1 distills) emit `reasoning_content` deltas natively |
| `PLURNK_PROVIDER_FETCH_TIMEOUT` | no | Universal fetch timeout in ms; default `600000` |

## context window & pricing

Both real, both pulled at `fromEnv` time from `GET /accounts/{id}/ai/models/search?search={alias}`. Cloudflare's catalog response carries each model's metadata as a `properties[]` array of `{property_id, value}` entries:

- `context_window` — string value, parsed as Number for `contextSize`
- `price` — value is an array of `{unit, price, currency}` entries:
  - `"per M input tokens"` → `prompt_pico_per_token = price × 1e6`
  - `"per M output tokens"` → `completion_pico_per_token = price × 1e6`
  - (Math: USD per 1M tokens × 1e12 pico/USD ÷ 1e6 tokens/M = `price × 1e6` pico/token)

Cloudflare does not expose a separate cached rate, so `cached_pico_per_token` mirrors `prompt_pico_per_token`. Most Workers AI requests have `cached_tokens = 0` regardless.

## tokenization

Heuristic 4-chars-per-token. Workers AI tokenizers vary by model family (sentencepiece for Llama-family, tiktoken-derived for the OpenAI gpt-oss releases, etc.). Per-family tokenizer dispatch is pass-2 work.

## license

MIT.
