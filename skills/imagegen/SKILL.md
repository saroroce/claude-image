---
name: imagegen
description: Generate images and short videos with FLUX on Cloudflare Workers AI. Picks a free draft model or a premium one per job, estimates cost before every paid call and enforces spend limits. Use when the user asks to create, generate or edit a picture, hero, banner, icon, mockup, illustration or photo, or a video or scroll-driven animation for a website. Also handles the slash forms /imagegen install (API key setup), /imagegen image, /imagegen video and /imagegen status.
argument-hint: "[install | image | video | status | what to generate]"
allowed-tools:
  - Bash(node ${CLAUDE_SKILL_DIR}/scripts/imagegen.mjs estimate *)
  - Bash(node ${CLAUDE_SKILL_DIR}/scripts/imagegen.mjs image --tier draft *)
  - Bash(node ${CLAUDE_SKILL_DIR}/scripts/imagegen.mjs frames *)
  - Bash(node ${CLAUDE_SKILL_DIR}/scripts/imagegen.mjs models*)
  - Bash(node ${CLAUDE_SKILL_DIR}/scripts/imagegen.mjs usage*)
  - Bash(node ${CLAUDE_SKILL_DIR}/scripts/imagegen.mjs status*)
---

# imagegen

Images and videos through Cloudflare Workers AI (FLUX). One CLI, several models, cost estimated before every paid call. Answer the user in their own language.

Run the CLI as `node ${CLAUDE_SKILL_DIR}/scripts/imagegen.mjs <command>` (written `imagegen` below). Keep the exact form `image --tier draft ...` with `--tier` first: only that form is pre-approved.

## Routing: /imagegen followed by a first word

Look at the first word of the request. It picks the flow, the rest is the payload.

| First word | Action |
|---|---|
| `install`, `setup`, `key` | Key setup, see Credentials and install. |
| `status`, `usage`, `models` | Run `imagegen status --check`, `imagegen usage` or `imagegen models` and summarize in a few lines. |
| `image`, `photo` | Image flow below. The rest of the text is the prompt. |
| `video` | Video flow below. The rest of the text is the prompt. |
| `frames` | `imagegen frames <file> ...` |
| nothing | Show these forms in two lines and run `imagegen status`. |
| anything else | Work out from the text and the conversation whether it is a photo or a video. Default to a free draft image. |

Translations of these words route the same way (for example `ключ`, `фото`, `видео`).

## Pick the tier

| Need | Command | Price |
|---|---|---|
| Drafts, iterations, previews, throwaway art (default) | `image --tier draft` | free daily allowance, about 95 images a day at 1024x1024 |
| Final site or marketing images, edits with references | `image --tier final` | from 0.03 USD per megapixel |
| Readable text in the frame: posters, UI mockups, infographics | `image --tier text` | from 0.05 USD per megapixel |
| Hero image, hardest edits, best fidelity | `image --tier hero` | from 0.07 USD per megapixel |
| Video, 5 to 20 s | `video` | 0.17 USD per second hd, draft 0.06 USD |

Start with draft. Move up only when composition and prompt are settled. Do not use hero where final is enough. Details and parameters: [references/models.md](references/models.md).

## Spending rules

1. Draft calls run directly.
2. Before any other call run `imagegen estimate image|video <same arguments>` and tell the user the price in plain words. Then run the real command. Paid commands are not pre-approved, so the user also confirms in the permission prompt.
3. Add `--yes` only after the user agreed to that specific amount in this conversation. Video always needs it.
4. Exit codes: 2 no credentials, 3 confirmation needed, 4 monthly budget reached, 5 API error. Never bypass 3 or 4 with `--yes` or `--override-budget` on your own. HTTP 402 means no Unified Billing credits: nothing was charged, tell the user to top up (AI Gateway, Credits, Top-up).
5. Identical requests are cached and cost nothing. Use `--force` only to re-roll on purpose. For variants change the prompt or `--seed`.

## Images

```
imagegen image --tier draft "prompt" --aspect 16:9 --out public/generated/hero-draft.jpg
imagegen image --tier final "prompt" --aspect 16:9 --ref reference.png --out public/generated/hero.jpg
```

Options: `--aspect 1:1|16:9|9:16|4:3|3:4|21:9`, `--mp 1` (megapixels, up to 4) or `--size 1360x768`, `--ref file|url` (draft up to 4, others up to 8), `--seed`, `--format jpeg|png|webp` (final, text, hero), `--steps` and `--guidance` (text tier only), `--json`. The default output folder is `./generated`; for a web project put files where the framework serves them (for example `public/generated/`) and write real alt text.

After a generation, open the file with Read once to check it. If it misses, fix the prompt on the draft tier, not on a paid one. When it looks right, send it to the chat straight away with the `SendUserFile` tool (a short caption in the user's language: tier, model, cost), so the picture shows up without the user hunting for a path. If that tool is not available, give the file path.

## Video and scroll-driven sites

1. If the subject must look exact (a phone, a product, a logo), make a clean still first (draft while iterating, `--ref` for a logo) and animate it with `--image still.png`. Do not rely on text or UI on screens inside generated video; overlay real logos and text afterwards.
2. Test the motion prompt cheaply: `estimate video --draft "prompt"`, then `video --draft --yes --duration 5 "prompt"`.
3. Final clip, only after the user agreed to the price: `video --yes --duration 8 [--image still.png] "prompt"`. Long runs go to the background. Audio is off by default. The result link expires in about two hours, so the CLI downloads at once. When the clip is ready, look at two or three frames to check it, then send the file with `SendUserFile`.
4. Cut frames for scrolling: `frames clip.mp4 --out public/media/hero --mobile 640`. It writes `manifest.json` and numbered frames (WebP when ffmpeg has libwebp, otherwise JPEG) plus a lighter mobile set.
5. Wire the page with [assets/scroll-sequence.js](assets/scroll-sequence.js); the recipe, budgets and pitfalls are in [references/scroll-video.md](references/scroll-video.md). If the Cloudflare plugin is installed, use its `web-perf` skill to audit the finished page.

## Credentials and install

The key lives in `~/.config/imagegen/env` (or the `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` variables). Never read, print or copy that file.

For `install`, or after exit code 2 from any command:

1. Run `imagegen status --check`. If the key exists and is valid, say so and stop, unless the user wants to replace it.
2. Otherwise start the wizard in the user's own terminal panel. Load `mcp__terminal__run_in_terminal` with ToolSearch (`select:mcp__terminal__run_in_terminal`) if its schema is not available, then call it with the command `node ${CLAUDE_SKILL_DIR}/scripts/imagegen.mjs setup` and the title `imagegen setup`. Tell the user to switch to that tab: the Account ID is typed there, the token is hidden and never reaches this chat.
3. Without a terminal tool (plain CLI, remote server) give the user that command to run in their own terminal or over SSH.
4. Never ask for the token in chat, never take one pasted into chat, never write one anywhere yourself, and do not read that terminal tab. If a token shows up in the chat anyway, tell the user to delete it in the Cloudflare dashboard and create a new one.
5. When the user says it is done, run `imagegen status --check`.

Reply to the user with this short guide (their language, links kept as they are), and nothing longer:

1. Open https://dash.cloudflare.com/?to=/:account/ai/workers-ai, press Use REST API, then Create a Workers AI API Token, Create API Token, Copy API Token (shown once). The Account ID is on the same page.
2. Switch to the terminal tab "imagegen setup" and paste the Account ID, then the token (input is hidden).
3. Only for video and paid models: top up credits at https://dash.cloudflare.com/?to=/:account/ai/ai-gateway (Credits Available, Manage, Top-up credits). Without credits the API answers 402 and nothing is charged.

Manual route if the button is missing: https://dash.cloudflare.com/profile/api-tokens, Create Token, Custom, permission Account / Workers AI with Read and Edit. Never the Global API Key.

`imagegen status --check` verifies the key and shows the budget; `imagegen usage` shows the ledger. If a response cannot be parsed, the raw reply is saved to `~/.local/share/imagegen/last-response.json`; read that file to see what changed in the API.
