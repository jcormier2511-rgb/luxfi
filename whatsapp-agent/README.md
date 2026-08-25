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
id,type,category,item,brand,ref,condition,price,location,contact_name,contact_phone,source,rating
```
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

## Conversation flow

1. **Outreach**: intro message (+ banner, if configured) sent to each Tier A/B contact.
2. **First reply**: bot shows 3 suggested items pulled from the WF feed and asks the contact to
   pick numbers (`1,3`) or name their own items (`buy: Omega Speedmaster`, `selling: Cartier
   Love bracelet`).
3. **Searching**: each item is searched against the WF inventory (buy → `FS` listings, sell →
   `WTB` listings). The bot opens with `SEARCHING_MESSAGE_BUYER`/`_SELLER` ("September Special:
   I'll match you with 3 verified sellers/buyers, free…"), then lists up to
   `TRIAL_MAX_OPTIONS_PER_ITEM` (default 5) options **without contact details** and asks
   *"Here are the people requesting '\<item\>'… do you want their info?"*
4. **Consent-gated reveal**: only on an affirmative reply does the bot send the same options
   back with the counterparty's name and phone number attached. Any other reply (or a new item
   request instead) skips the reveal and moves on — the item still counts toward the trial
   either way, since the search itself was the delivered value.
5. **Trial gate**: after `TRIAL_MAX_ITEMS` (default 3) items have been searched, the bot sends
   *"Reached my free quota — you're welcome to start a trial membership here: `MEMBERSHIP_URL`"*
   (plus `or schedule a demo here: DEMO_URL` if that's set), and stops taking new item requests.
6. Replying `STOP`/`UNSUBSCRIBE` at any point opts a contact out permanently (`START` re-enables).

State per phone number is persisted to `storage/conversations.json` (git-ignored) so the bot
survives restarts.

## Not yet wired up

- No real payment/membership gate — the trial-ended message just links out to `MEMBERSHIP_URL`.
- Matching is keyword-based against the CSV snapshot, not a live feed — refreshing
  `wf_inventory.csv` requires a restart (or extending `inventoryStore.ts` to poll/reload).
- No delivery-status or read-receipt handling — only inbound text messages are processed.
