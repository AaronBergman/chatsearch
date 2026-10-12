# ChatSearch (Chrome extension)

Real search for your Claude and ChatGPT history: live substring search (trigram-Bloom prefilter + exact verification), fuzzy titles and "did you mean", and semantic search (on-device by default, optional cloud relay). Built 2026-10-12 from Aaron's goal prompt (context screenshots in `context/`, not for the public repo). Public repo: github.com/AaronBergman/chatsearch. Landing page: abergman.com/chatsearch (template in `~/personal_site/site/templates/chatsearch.html`, images in `site/static/img/chatsearch/`).

## Commands

- `npm run build` (dist/, load unpacked), `npm run watch`, `npm run typecheck`.
- `npm test`: unit tests + 10k-chat scale benchmark (`SCALE_N`, `SCALE_CHARS` env to resize).
- `npm run e2e` (`test/e2e/run.mjs`): headless Chromium (`channel: 'chromium'`, needs `npx playwright install chromium`) with the built extension; claude.ai/chatgpt.com are mapped to a local HTTPS mock (`test/e2e/mock.mjs`) via `--host-resolver-rules`. 23 checks incl. sync, 429 backoff, Cloudflare-challenge handling, capture, jump-to-match, deletion, local semantic and cloud semantic (hits the live relay, well under a cent). Screenshots in `test/e2e/out/`, failure screenshots `fail-*.png`.
- `node test/e2e/demo.mjs`: marketing screenshots from a made-up realistic history into `assets/screens/` (also copied to the site).
- `npm run zip`: `release/chatsearch-<version>.zip`. Release asset must be named `chatsearch.zip` so `releases/latest/download/chatsearch.zip` links work.
- `test/real/validate.ts`: bundle and run inside a claude.ai / chatgpt.com tab to check extraction against real data (aggregate stats only, no content).

## Layout

- `src/shared/` types, IndexedDB wrapper (`db.ts`), length-preserving normalization (`normalize.ts`), per-doc trigram Bloom filters (`bloom.ts`), raw JSON -> messages (`extract.ts`), index records + semantic chunks (`indexer.ts`), query syntax (`query.ts`).
- `src/sw/` service worker: sync scheduler + site adapters (`claude.ts`, `chatgpt.ts`), ingest, omnibox, alarms, message routing.
- `src/offscreen/` offscreen document = warm search engine (`engine.ts`) + semantic index (`semantic.ts`) + embedding worker (`embed-worker.ts`, transformers.js).
- `src/content/` MAIN-world fetch hook (captures conversations the page itself loads, zero extra requests) + isolated bridge (relays to SW, jump-to-match highlighting, ChatGPT DOM capture). Both run at `document_start` (the bridge at document_idle missed early captures).
- `src/ui/` Preact app used by popup, side panel and full-page tab.
- `relay/` cloud embedding relay, deployed on Railway project `chatsearch-relay` (service `chatsearch-relay`, volume at `/data` for usage counters) at https://chatsearch-relay-production.up.railway.app. DeepInfra `Qwen/Qwen3-Embedding-8B`, 512 dims, caps: 1B tokens/month global, 150M/month and 60M/day per client, 300M/month per IP. Key is the Railway variable `DEEPINFRA_API_KEY`. Redeploy: `cd relay && railway up --detach`.

## Hard-won facts (measured 2026-10-12 on Aaron's accounts)

- Claude: `GET /api/organizations` -> orgs with `capabilities` incl. `chat`. List: `/api/organizations/{org}/chat_conversations_v2?limit=&offset=&consistency=eventual` -> `{data, has_more}`, newest-updated first. Each list item carries a ~30 KB `settings` blob, so always page. Detail: `/chat_conversations/{uuid}?tree=True&rendering_mode=messages&render_all_tools=true`. No observed rate limit.
- Claude thinking blocks arrive with `thinking: ""` and the visible text in `summaries[].summary`. Tool uses are mostly web_search/WebFetch (not indexed); Write/Edit/create_file inputs are indexed as artifacts.
- ChatGPT: token from `GET /api/auth/session` (`accessToken`), then `Authorization: Bearer`. List `/backend-api/conversations?offset=&limit=100&order=updated`. Archived via `&is_archived=true`. Projects via `/backend-api/gizmos/snorlax/sidebar` + `/backend-api/gizmos/{id}/conversations?cursor=`. Detail `/backend-api/conversation/{id}`. **Rate limit: ~200 burst then ~1 read/minute, shared with the user's browsing.** Code to the sandbox has recipient `container.exec` (plain text); other tool namespaces are obfuscated (e.g. `de1d73e.create`) with JSON payloads.
- Cloudflare: a fresh or headless profile can get an HTML challenge page (403 + `cf-mitigated: challenge`) instead of API JSON. `net.ts` flags that as `HttpError.blocked` (not signed-out, not a 429): `fail()` pauses 5 min with "open the site once", and a `page`/`user` sync ignores any pause except a real rate limit (`pauseReason === 'rate'`).
- Aaron's scale: ~5,700 Claude chats, 4,400+ ChatGPT chats.
- Extension-origin fetch with `credentials: 'include'` works for both sites.
- onnxruntime sessions must never run concurrently: the embed worker serializes jobs (queries jump the queue). Concurrent runs silently corrupted vectors. The worker also self-tests embedding quality at init (bad GPU output falls back to WASM).
- mdbr-leaf-ir cosine for a clearly on-topic chat is ~0.5 (unrelated ~0.1-0.3); Qwen3 via relay ~0.65 vs ~0.2. Semantic "strong/related/weak" bands in `semantic.ts` are calibrated from these.

## Conventions

- Scripts: no CLI args. Python via `uv`. No em dashes in any user-facing text.
- Never print or commit API keys.
- UI state restore must never overwrite what the user already typed (fast typists open the popup and type immediately).
