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
- Real contact CSVs are git-ignored on purpose (`data/contacts.csv`) — don't remove that from
  `.gitignore`; this data shouldn't live in git history. WatchFacts inventory isn't a CSV at
  all anymore — see [WatchFacts Trading Floor sync](#watchfacts-trading-floor-sync-live-inventory-feed).

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

Drop a real export at `data/contacts.csv` (git-ignored). Until it exists, the app falls back to
`data/contacts.sample.csv` with a console warning, so it runs out of the box for local testing.

**`contacts.csv`**
```
phone,name,tier,specialty
15551234567,Marco D.,A,watches
```
`tier` is `A`, `B`, or `C` — only `A`/`B` are targeted by the outreach blast. `specialty` is
optional and steers which category of WF listing gets suggested first. `wf_profile_id` is
optional — see [WatchFacts intro personalization](#watchfacts-intro-personalization-optional).

WatchFacts inventory (FS + WTB) isn't a file you drop in at all — it's synced automatically
from WatchFacts' own API into a SQLite database on the persisted volume. See
[WatchFacts Trading Floor sync](#watchfacts-trading-floor-sync-live-inventory-feed).

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
7. **Seed the real contacts** onto the (now-empty) volume — `contacts.csv` is git-ignored, so
   it isn't in the deployed image:
   ```bash
   curl --data-binary @contacts.csv "https://<your-railway-domain>/admin/upload/contacts?token=<WEBHOOK_TOKEN>"
   ```
   Responds with a row count and takes effect immediately (no restart needed). WatchFacts
   inventory doesn't need seeding — the boot-time scheduler syncs it automatically as long as
   `WATCHFACTS_EMAIL`/`WATCHFACTS_PASSWORD` are set (see below).
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

Pulls real listings directly from WatchFacts' own JSON API — **not** DOM/button-text scraping.
An earlier version of this scraper walked the rendered page looking for a "Check Availability"
button and inferred title/seller from nearby text; in production that regularly grabbed CTA
text like "View Details" as the item/seller name and collapsed distinct listings onto one id
whenever the phone-number fallback collided. That whole approach is gone.

**The real endpoint** (found by capturing the site's own network traffic while logged in):
```
GET https://watchfacts.com/available-flash-sales?pageSize=25&page=1&auction_type=sale&category_id=19&sort_by=date-newest
```
- **Auth**: session-cookie only — no API key/bearer token. A request without a valid
  WatchFacts login cookie gets `{"message":"session_expired"}`, so every call runs inside an
  authenticated Playwright page via `page.evaluate(() => fetch(url, {credentials:"include"}))`
  rather than a standalone HTTP client (see `src/watchfacts/api.ts`).
- **FS vs WTB**: same endpoint, different `auction_type` value. `sale` is confirmed for FS.
  **The WTB value is not hardcoded** — the site's own toggle button isn't a real, reliably
  clickable element, so `resolveWtbAuctionType()` tries a short list of likely values
  (`wtb`, `buy`, `want_to_buy`, `ntq`, …) directly against the API on each sync and uses
  whichever one actually returns rows. If WatchFacts' real value isn't in that list, the sync
  fails loudly (`Could not find a working auction_type value for WTB`) rather than silently
  mislabeling FS listings as WTB — which is what the old DOM scraper did when its toggle click
  timed out.
- **Pagination**: `pageSize`/`page` query params, confirmed present. `fetchAllFlashSales()`
  keeps requesting increasing pages until one comes back shorter than `pageSize` (or empty),
  so all active listings are fetched, not just the first page — capped at 50 pages as a safety
  valve against an infinite loop, not an expected ceiling.
- **Closed/expired listings**: each result carries `status` (`"open"` when live) and its own
  `deadline` timestamp. `isActive()` requires both — `status === "open"` AND `deadline` still
  in the future — so a listing WatchFacts marks closed, or one whose flash sale has simply
  timed out, is filtered out before it ever reaches the matching engine.
- **What wasn't empirically confirmed**: the exact shape of the response envelope for a full
  page (a raw array vs `{data:[...]}`) — `fetchFlashSalesPage()` in `api.ts` handles either
  shape defensively rather than assuming one.

**Storage**: a SQLite database at `PERSIST_DIR/data/inventory.sqlite` (`better-sqlite3`) —
replacing the old wholesale-overwrite CSV. Each row's key is `(source, type, external_id)`,
so an FS and a WTB listing that happen to share the same WatchFacts id stay two separate rows.
A sync **upserts** (new listings inserted, existing ones updated, `first_seen_at` preserved)
and only marks a side's stale rows `is_active = 0` if that side's fetch returned at least one
result — a 0-row fetch (network hiccup, WatchFacts change) never wipes out good data, matching
the guard the old CSV-based sync had.

**Scheduling**: `src/index.ts` runs a sync on boot and every `INVENTORY_SYNC_INTERVAL_MINUTES`
(default 5) as long as `WATCHFACTS_EMAIL`/`WATCHFACTS_PASSWORD` are set — no external cron
needed. Each tick is a fresh login (no persistent browser session reused across ticks yet),
which is why the interval defaults to 5 minutes rather than 1-2: repeated logins are the same
category of risk as the WhatsApp number bans hit earlier in this project. `POST
/admin/sync-inventory?token=<WEBHOOK_TOKEN>` triggers one manually; both paths share one
re-entrancy guard, so they can't run two logged-in sessions at once.

**Status**: `GET /admin/inventory-status?token=<WEBHOOK_TOKEN>` returns
`{lastSuccessAt, lastAttemptAt, lastError, fsCount, wtbCount, totalActiveCount}`.

**Tests**: `npm test` (Node's built-in test runner, no new framework) covers the pure mapping
logic (`isActive`, `mapToInventoryListing` — including that a 0 top-level price maps to
`"ASK"` and contact fields never end up as CTA text) and the DB layer (upsert-not-duplicate,
FS/WTB-same-id-stay-separate, `markMissingInactive` never touching the other type or wiping
everything on an empty result). These don't hit the real network — this sandbox can't reach
watchfacts.com — so they can't catch a change in WatchFacts' actual response shape; only a
live `/admin/sync-inventory` run can.

Known gaps: no persistent session reuse across scheduler ticks (fresh login every 5 min);
`category_id=19` and `category: "watches"` are hardcoded since that's all the Trading Floor
currently shows; the response-envelope shape (raw array vs `{data:[...]}`) is handled
defensively but not confirmed either way.

## Group monitoring (passive listening)

Add this channel's WhatsApp number to a real dealer group the same way you'd add any contact,
and the bot silently watches for WTB/FS-style posts and feeds them into the matching engine —
this is the original "Fi monitors dealer groups" idea from the landing page. It **never
replies into the group**; it only reads.

- Recognizes dealer shorthand: `WTB`/`ISO`/`LF`/"looking for" → a want-to-buy post, `FS`/`WTS`/
  "for sale"/"selling" → a for-sale post. A price is pulled out with a simple `$1,234` pattern
  (doesn't yet handle shorthand like "18k" — falls back to `ASK`). Anything that doesn't match
  either keyword set is ignored — normal group chatter never becomes a listing.
- Captured posts go to their own file (`group_listings.csv`) rather than into the WatchFacts
  inventory DB directly — kept separate on purpose so a `/admin/sync-inventory` run can never
  wipe out what a group has posted. `getActiveListings()` in `inventoryDb.ts` merges both.
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
- Matching is keyword-based against whatever's currently active in the inventory DB — kept
  fresh automatically by the boot-time scheduler (see WatchFacts Trading Floor sync above),
  or on demand via `POST /admin/sync-inventory`.
- No delivery-status or read-receipt handling — only inbound text messages are processed.
- `/admin/upload/*` and `/outreach/*` share one bearer-style token (`WEBHOOK_TOKEN`) passed as a
  URL query param — fine for a single-operator pilot, not a substitute for real auth if more
  people get access to these endpoints.
