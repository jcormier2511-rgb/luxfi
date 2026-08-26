# LuxFi WhatsApp Outreach Agent

Reaches out to Tier A/B dealer contacts over WhatsApp (via [Whapi.Cloud](https://whapi.cloud)),
asks them for up to 3 items they want to buy or sell (suggesting 3 trending items from the
WF inventory feed as a starting point), searches for counterparty matches, and gates on a
3-item / 5-options-per-item trial before pointing to the membership signup link.

## ⚠️ Before sending anything real

- **Whapi.Cloud is not Meta's official WhatsApp Business API** — it automates a regular WhatsApp
  Web session. Bulk first-contact outbound to numbers that have never messaged you is exactly
  what WhatsApp's spam detection looks for; a fresh/burner number doing this at volume can get
  banned fast. Start with a small pilot batch (a handful of contacts), not the full list.
- **Consent/legal**: contacts sourced from passive group-activity monitoring have not opted in
  to being messaged. Unsolicited commercial texts can trigger TCPA (US), PECR/GDPR (UK/EU), or
  similar laws depending on where recipients are. Confirm your legal basis for outreach before
  scaling beyond a pilot.
- Real contact/inventory CSVs are git-ignored on purpose (`data/contacts.csv`,
  `data/wf_inventory.csv`) — don't remove that from `.gitignore`; this data shouldn't live in
  git history.

## Setup

```bash
cd whatsapp-agent
npm install
cp .env.example .env
```

Fill in `.env`:
- `WHAPI_TOKEN` — from your Whapi.Cloud channel dashboard after scanning the burner number's
  QR code to link it.
- `WEBHOOK_TOKEN` — any random string; protects the `/webhook` and `/outreach/start` endpoints.
- `INTRO_MESSAGE` — your intro copy. `{{name}}` is replaced per-contact; `\n` becomes a newline.
- `BANNER_IMAGE_URL` — a **publicly reachable** URL for your banner image (Whapi's
  `/messages/image` endpoint fetches it server-side; it can't take a local file path). Leave
  blank to send the intro as plain text with no image.
- `MEMBERSHIP_URL` — the signup link sent when a contact's trial ends.

## Data files

Drop real exports at `data/contacts.csv` and `data/wf_inventory.csv` (both git-ignored). Until
those exist, the app falls back to the sample files under `data/*.sample.csv` with a console
warning, so it runs out of the box for local testing.

**`contacts.csv`**
```
phone,name,tier,specialty
15551234567,Marco D.,A,watches
```
`tier` is `A`, `B`, or `C` — only `A`/`B` are targeted by the outreach blast. `specialty` is
optional and steers which category of WF listing gets suggested first. `wf_profile_id` is
optional — see [WatchFacts intro personalization](#watchfacts-intro-personalization-optional).

**`wf_inventory.csv`**
```
id,type,category,item,brand,ref,condition,price,location,contact_name,contact_phone,source,rating,description
```
`description` is the full original listing text (e.g. from the WF detail page) — shown to
contacts instead of `item` when present, since `item` alone can be a truncated card title.
`type` is `FS` (for sale) or `WTB` (want to buy). A buy request matches against `FS` rows; a
sell request matches against `WTB` rows.

## Running

```bash
npm run dev
```

Configure the Whapi.Cloud channel's webhook URL (Settings → Webhooks, with the `messages`
event enabled) to:

```
https://<your-host>/webhook?token=<WEBHOOK_TOKEN>
```

Kick off the Tier A/B blast (only contacts still at stage `new` are messaged, capped at
`OUTREACH_BATCH_LIMIT` per run and paced at `OUTREACH_RATE_PER_HOUR`, so re-running is safe and
picks up where the last batch left off — current defaults: 50 contacts, 5/hour):

```bash
npm run outreach   # blocks until the whole batch is sent (can take hours at low rates)

# or, once the server is running — plans the batch and returns immediately,
# sending happens in the background:
curl -X POST "http://localhost:3000/outreach/start?token=<WEBHOOK_TOKEN>"
curl "http://localhost:3000/outreach/status?token=<WEBHOOK_TOKEN>"
```

## Deploy (Railway)

This needs an **always-on** host with **persistent disk** — not serverless (Vercel, Cloudflare
Workers, Cloud Run's default scale-to-zero). The outreach blast runs as a long background loop
*inside* the Node process (hours, at low `OUTREACH_RATE_PER_HOUR`), and conversation state /
blast progress are plain JSON files on disk that must survive restarts and redeploys.

1. **New Project → Deploy from GitHub repo**, pick this repo.
2. **Settings → Root Directory**: set to `whatsapp-agent` (this is a subfolder of a monorepo).
   Railway will pick up `railway.json` and `Dockerfile` from there automatically.
3. **Add a Volume**, mounted at `/app/persist`. In Railway's canvas UI this is attached to
   the service directly — right-click the service card and look for "Attach Volume" (it's
   not in the "+ Add" menu, which is only for new services/databases). One volume covers
   everything: conversation state, blast status, and anything uploaded via the endpoints
   below all live under `PERSIST_DIR` (`/app/persist` by default) so they survive redeploys.
4. **Variables** — set at minimum:
   - `WHAPI_TOKEN`, `WEBHOOK_TOKEN` (pick a real random value, not `change-me`)
   - `INTRO_MESSAGE`, `BANNER_IMAGE_URL`, `MEMBERSHIP_URL`, `DEMO_URL`
   - `SEARCHING_MESSAGE_BUYER`, `SEARCHING_MESSAGE_SELLER` (defaults match the provided copy —
     only set these if you want to override them)
   - Leave `OUTREACH_BATCH_LIMIT`, `OUTREACH_RATE_PER_HOUR`, `TRIAL_MAX_ITEMS`,
     `TRIAL_MAX_OPTIONS_PER_ITEM` unset to use the defaults (50, 5/hr, 3, 5), or override.
   - `WATCHFACTS_ENABLED`, `WATCHFACTS_EMAIL`, `WATCHFACTS_PASSWORD` if using that feature.
   - Do **not** set `PORT` — Railway injects it.
5. **Deploy.** Railway assigns a public domain under Settings → Networking (or attach a custom
   one). `numReplicas` is pinned to `1` in `railway.json` — don't scale this past one instance,
   since the blast loop and file-based state assume a single process.
6. In the **Whapi.Cloud dashboard**, set the channel's webhook URL to
   `https://<your-railway-domain>/webhook?token=<WEBHOOK_TOKEN>`.
7. **Seed the real data** onto the (now-empty) volume — the real CSVs are git-ignored, so they
   aren't in the deployed image:
   ```bash
   curl --data-binary @contacts.csv "https://<your-railway-domain>/admin/upload/contacts?token=<WEBHOOK_TOKEN>"
   curl --data-binary @wf_inventory.csv "https://<your-railway-domain>/admin/upload/inventory?token=<WEBHOOK_TOKEN>"
   ```
   Each responds with a row count and takes effect immediately (no restart needed).
7a. **No banner host?** Set `PUBLIC_BASE_URL` to this deployment's own domain (e.g.
   `https://your-app.up.railway.app`), then push the image straight to this server instead of
   needing a third-party image host:
   ```bash
   curl --data-binary @banner.jpg "https://<your-railway-domain>/admin/upload/banner?token=<WEBHOOK_TOKEN>"
   ```
   The response includes the `url` to paste into `BANNER_IMAGE_URL` (it's served back out at
   `/assets/banner.jpg`). Requires the volume from step 3 so it survives redeploys.
8. Kick off the blast: `curl -X POST "https://<your-railway-domain>/outreach/start?token=<WEBHOOK_TOKEN>"`,
   then poll `GET /outreach/status` the same way.

The Dockerfile installs Playwright's Chromium at build time (needed only if
`WATCHFACTS_ENABLED=true`, but included unconditionally so toggling that var doesn't need a
rebuild) — this was written but never build-tested end-to-end, since this sandbox's network
policy blocks pulling the base image from Docker Hub. Railway's own build environment has
unrestricted internet, so this should just work there; if the build fails, that's the first
thing to check the logs for.

## WatchFacts intro personalization (optional)

Set `WATCHFACTS_ENABLED=true` and fill in `WATCHFACTS_EMAIL`/`WATCHFACTS_PASSWORD` in `.env` to
have the blast log into watchfacts.com once per run and, for each contact with a `wf_profile_id`
in `contacts.csv` (the id from `watchfacts.com/profile-listings?profileId=<id>`), open their
intro with their own most recent listing — e.g. *"Saw you just posted 'Rolex Daytona 116500LN'
for $18,500 — nice piece."* A contact with no `wf_profile_id`, or any scrape failure, just gets
the plain `INTRO_MESSAGE` — this never blocks or fails the batch.

**This was built without ever seeing the live site** — the sandbox this was developed in has
`watchfacts.com` blocked at the network level, so `src/watchfacts/scraper.ts` infers listing
cards from screenshots rather than real markup. Before trusting it on a real run:

1. Install a browser once, wherever you actually run the blast: `npx playwright install chromium`.
2. Validate against a real profile: `npm run wf:test -- <profileId>` — prints the extracted
   `{ id, title, price }` or `null`. If it returns `null` or the wrong listing, the DOM-walking
   heuristic in `extractLatestListing()` needs adjusting to match the real page structure.
3. Only then set `WATCHFACTS_ENABLED=true` for a live blast.

## WatchFacts Trading Floor sync (live inventory feed)

Replaces the static `wf_inventory.csv` with real listings scraped from WatchFacts' own
Trading Floor (`watchfacts.com/buy/all`) — both `$ FOR SALE` and `NTQ/WTB` sides — instead of
the sample data. Uses the same `WATCHFACTS_EMAIL`/`WATCHFACTS_PASSWORD` login as the intro
personalization feature above. Each listing's seller contact comes from the phone number
embedded in its "Check Availability" WhatsApp link (`wa.me/<number>`), which is free to view
(confirmed — doesn't consume the account's WatchFacts credits).

**List-page extraction (title/price/rating/seller/phone) has been validated against the live
site** (Aug 2026 — a real sync pulled 20 FS + 20 WTB listings successfully). The per-listing
**detail-page description** (`extractDetailDescription()` — visits each `/flash-sales/<id>`
page for the full, non-truncated listing text) has not been live-tested yet:

1. `npx playwright install chromium` (skip if already done for intro personalization).
2. `npm run wf:test-inventory -- sale` (or `-- wtb`) — logs in, scrapes one side of the feed
   including descriptions, and prints each extracted row as JSON. Check that `description`
   looks like real listing text (not empty, not "See More" or other UI chrome); if not,
   `extractDetailDescription()` in `src/watchfacts/scraper.ts` needs adjusting.
3. Once that looks right, run a real sync: `npm run wf:sync-inventory` (local/CLI), or on a
   deployed instance: `curl -X POST "https://<your-railway-domain>/admin/sync-inventory?token=<WEBHOOK_TOKEN>"`
   — both overwrite `wf_inventory.csv` with fresh FS + WTB listings (refuses to do so if the
   scrape comes back with 0 rows, so a transient failure can't wipe out good data). Visiting
   each listing's detail page for its description adds roughly 1-2 seconds per listing on
   top of the list-page scrape.
4. If something looks off, `POST /admin/sync-inventory`'s response includes
   `debugScreenshots` (also just `GET`-able directly at `/assets/debug-trading-fs.png` and
   `/assets/debug-trading-wtb.png`) — full-page screenshots of exactly what the scraper saw,
   useful without needing a local Playwright setup.
5. To keep it fresh, point an external cron (or a second Railway service on a schedule) at
   that `/admin/sync-inventory` endpoint every hour or so — there's no built-in scheduler for
   this yet, unlike the outreach blast's own pacing.

Known gaps: only reads the first page of results (no "load more"/pagination handling), and
`category` is hardcoded to `"watches"` since that's all the Trading Floor currently shows.

## Group monitoring (passive listening)

Add this channel's WhatsApp number to a real dealer group the same way you'd add any contact,
and the bot silently watches for WTB/FS-style posts and feeds them into the matching engine —
this is the original "Fi monitors dealer groups" idea from the landing page. It **never
replies into the group**; it only reads.

- Recognizes dealer shorthand: `WTB`/`ISO`/`LF`/"looking for" → a want-to-buy post, `FS`/`WTS`/
  "for sale"/"selling" → a for-sale post. A price is pulled out with a simple `$1,234` pattern
  (doesn't yet handle shorthand like "18k" — falls back to `ASK`). Anything that doesn't match
  either keyword set is ignored — normal group chatter never becomes a listing.
- Captured posts go to their own file (`group_listings.csv`, next to `wf_inventory.csv`) rather
  than into the WatchFacts feed directly — kept separate on purpose so a `/admin/sync-inventory`
  run (which overwrites `wf_inventory.csv` wholesale) can never wipe out what a group has
  posted. The matching engine reads both together.
- Check what's been captured any time with `GET /admin/group-listings?token=<WEBHOOK_TOKEN>`
  — returns the count and raw CSV, since group monitoring never sends a reply you could watch
  for confirmation.

**Not yet validated against a real group** — the group-vs-1:1 detection assumes the standard
WhatsApp/Whapi convention (a group's `chat_id` ends in `@g.us`, and `from_name` carries the
sender's display name), inferred from documentation rather than a live group webhook payload.
Add the number to a real group, post a test "WTB ..." message, and check
`GET /admin/group-listings` — if it's empty, check the Railway deploy logs for the raw webhook
body around that time to see the actual field names Whapi sent, and adjust
`extractIncomingMessages()` in `src/whapi/client.ts` accordingly.

## Conversation flow

Implements the **Fi Conversation Flow Spec (v3)** — a hired-concierge framing, not a
WatchFacts subscription. Billing is **tracked only right now**: `approvedCount` and `hired`
live on each contact's state, but no payment processor is wired in, so nothing is actually
charged — "join" just unlocks unlimited approvals going forward.

1. **Outreach**: intro message (+ banner, if configured) sent to each Tier A/B contact — this
   is `INTRO_MESSAGE`, the outbound blast opener (short, gets them to reply).
2. **First reply**: the first time a contact replies at all, the bot sends `FI_INTRO_MESSAGE`
   (Fi's own concierge introduction, spec §1) once, then waits for an item.
3. **Preferences (once per contact)**: the very first item request a contact sends triggers
   four quick questions, one at a time — price range, location, dial color, condition — before
   any search runs (`src/conversation/preferences.ts` does the loose parsing: "$5k-8k", "under
   10000", "Miami", "any", etc; any answer maps to "no preference"). Answers are stored on
   `state.preferences` and reused for every later search — they're never asked again.
4. **Searching is unlimited**: `buy: Rolex Daytona` / `selling: Hermes Birkin` (or `sell`, `fs`,
   `wtb`, `looking for`, etc.) searches the inventory (buy → `FS` listings, sell → `WTB`
   listings) and shows up to `TRIAL_MAX_OPTIONS_PER_ITEM` (default 5) **Match Cards** — spec §2,
   minus the "Fi Intelligence" block (dealer reputation/price trend/market range/authenticity),
   since no data source for any of that exists yet. Only one search's cards are "live" for
   decisions at a time — starting a new search replaces the previous one. Price preference is a
   hard filter (falls back to sorting by closest price if it would empty the results); location/
   dial/condition nudge sort order rather than excluding listings outright, since they're
   freeform text and a strict match would too easily zero out results.
5. **Approve / Pass**: reply `approve <number>` or `pass <number>` against the cards just
   shown. Passing is free and unlimited. Approving reveals the counterparty's phone number —
   and is the only thing metered against the trial.
6. **Trial gate**: after `TRIAL_MAX_APPROVED_MATCHES` (default 3) *approvals* — not searches —
   the bot sends the conversion pitch (spec §5) once. Every approve attempt after that, until
   they reply `join`, gets the decline-path message (spec §7) instead; searching and passing
   keep working the whole time.
7. Replying `STOP`/`UNSUBSCRIBE` at any point opts a contact out permanently (`START` re-enables).

State per phone number is persisted to `storage/conversations.json` (git-ignored) so the bot
survives restarts — which also means it survives redeploys. If you've already tested with your
own number, it's no longer `"new"`, so you won't see `FI_INTRO_MESSAGE` again just by redeploying.
Reset it with:

```
curl -X POST "https://<your-railway-domain>/admin/reset-state?phone=<digits-only>&token=<WEBHOOK_TOKEN>"
```

(phone is digits only, no leading `+`, e.g. `15551234567`). Check current state anytime with
`GET /admin/conversation-state?phone=<digits-only>&token=<WEBHOOK_TOKEN>`.

## Not yet wired up

- No real billing — `approvedCount`/`hired` are tracked per contact but nothing is actually
  charged (no payment processor wired in). "Join" is a trust-based unlock, not a checkout.
- No "Fi Intelligence" data (dealer reputation/vouch, price trend, market range, price signal,
  authenticity check) — Match Cards ship without that block per spec §2 until a real data
  source for any of it exists.
- No cross-system WatchFacts/Fi membership check (spec §4's discount logic) — would need a
  shared identity layer between the two systems that doesn't exist yet.
- Matching is keyword-based against a CSV snapshot, not a live feed — refresh it by re-running
  `POST /admin/upload/inventory` (takes effect immediately, no restart) or editing the file and
  restarting the process.
- No delivery-status or read-receipt handling — only inbound text messages are processed.
- `/admin/upload/*` and `/outreach/*` share one bearer-style token (`WEBHOOK_TOKEN`) passed as a
  URL query param — fine for a single-operator pilot, not a substitute for real auth if more
  people get access to these endpoints.
