# Models, prices, parameters

Prices checked 2026-09-21. Cloudflare bills hosted models in neurons ($0.011 per 1000, 10 000 free per day, Free plan stops instead of charging). Third-party models (pro, flex, max, video) are billed through Unified Billing credits; their exact prices are in the Cloudflare dashboard, the table uses Black Forest Labs list prices. Override with `imagegen config set prices.pro.first 0.03`.

| Alias | Model id | Call shape | Refs | Price basis |
|---|---|---|---|---|
| klein-4b (draft) | `@cf/black-forest-labs/flux-2-klein-4b` | multipart form | 4 | 26.05 neurons per 512x512 output tile, 5.37 per input tile |
| klein-9b | `@cf/black-forest-labs/flux-2-klein-9b` | multipart form | 4 | 1363.64 neurons for the first megapixel, 181.82 per extra |
| schnell | `@cf/black-forest-labs/flux-1-schnell` | JSON | 0 | 4.8 neurons per tile plus 9.6 per step, fixed 1024x1024, prompt up to 2048 chars |
| pro (final) | `black-forest-labs/flux-2-pro-preview` | unified JSON | 8 | from $0.03 per MP, editing from $0.045 |
| flex (text) | `black-forest-labs/flux-2-flex` | unified JSON | 8 | from $0.05 per MP; steps 1-50, guidance 1.5-10, prompt upsampling |
| max (hero) | `black-forest-labs/flux-2-max` | unified JSON | 8 | from $0.07 per MP |
| video | `black-forest-labs/flux-3-video` | unified JSON | keyframes 1-10 | $/s: t2v and i2v hd 0.17, fhd 0.29, draft 0.06; v2v hd 0.41, fhd 0.53, draft 0.12 |

Sizes: multiples of 16, at most 4 MP (2048x2048). More than 1 MP is estimated as a full price per started megapixel (an upper bound; BFL charges less for the extra ones).

Native endpoint: `POST /accounts/{id}/ai/run/{model id}`. Unified endpoint: `POST /accounts/{id}/ai/run` with `{"model": ..., "input": {...}}`; the answer has `state` and `result.image` (URL) or `result.video` (URL, about 2 hours).

Video input: `mode` t2v|i2v|v2v, `prompt`, `resolution` hd|fhd, `duration` 5-20, `generate_audio`, `aspect_ratio` auto|21:9|2:1|16:9|4:3|1:1|3:4|9:16, `draft` (hd only), `keyframes` (i2v), `start_video` (v2v: https URL, up to 50 MB and 15 s).

## What was verified against the mock, not the live API

The request shapes follow the Cloudflare and BFL documentation, and the whole flow is covered by tests against a local mock. Not yet confirmed on a live account: the exact multipart field names for klein beyond `prompt`, `width`, `height`, `input_image_N`; whether klein returns JPEG or PNG (the CLI sniffs the bytes); whether long video requests answer synchronously (the CLI waits up to 15 minutes). If a first call misbehaves, the raw reply is in `~/.local/share/imagegen/last-response.json`.
