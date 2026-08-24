# Fi — LuxFi's WhatsApp agent

Backend for Fi, the agent described on the LuxFi landing page (`../index.html`):
it sits silently in dealer WhatsApp groups, captures WTB ("want to buy") and
FS ("for sale") posts, matches them across the network, pulls a review
profile on the counterparty before notifying either side, and charges
credits per verified match.

## How it works

1. **Green API webhook** (`POST /webhook/green-api`) receives every message
   Fi's WhatsApp number can see — both group messages and 1:1 DMs sent to Fi.
2. **Group messages** are parsed (`src/parsing/listingParser.ts`) for a
   WTB/FS pattern. A hit becomes a `Listing` row and is run through the
   matcher (`src/domain/matchingService.ts`). Fi **never posts back into the
   group** — it only reads. All notifications go out as 1:1 DMs to the two
   dealers involved.
3. **Matching** (`src/matching/scoreMatch.ts`) requires the brand to match
   on both sides, scores reference/price/location, and rejects the pair if
   the seller's ask is well above the buyer's stated max.
4. **Credits** (`src/domain/creditsService.ts`): each dealer's first 3
   matches are free; after that, 15 credits are charged per side per match.
   If either dealer can't afford it, Fi DMs them to top up and leaves both
   listings open for a future match instead of charging.
5. **Reviews** (`src/domain/reviewService.ts`): before a match is delivered,
   Fi looks up the counterparty's on-file reviews, or — if none exist yet —
   heuristically scans stored group chat history for vouch-like mentions of
   that dealer's name. Dealers can also ask Fi directly ("check reviews for
   @name") or request a vouch from a counterparty after a deal ("request a
   review from @name for the Daytona deal"); replying to that DM with a
   `1`-`5` rating records the vouch.

## Setup

```bash
cp .env.example .env    # fill in DATABASE_URL and Green API credentials
npm install
npm run prisma:generate
npm run prisma:migrate  # creates the schema in DATABASE_URL
npm run dev
```

### Green API

1. Create an instance at https://console.green-api.com and scan the QR code
   with the WhatsApp number Fi should run as.
2. Copy `idInstance` / `apiTokenInstance` into `.env`.
3. Point the instance's webhook URL at
   `https://<your-host>/webhook/green-api` (add `?token=<WEBHOOK_TOKEN>` if
   you set one), with `incomingMessageReceived` enabled.
4. Add the number to a dealer group as a normal participant — Fi starts
   reading immediately, no group-admin action needed.

### Local testing without live WhatsApp

Set `ENABLE_DEV_SIMULATE=true` and POST synthetic messages:

```bash
curl -X POST localhost:3000/simulate/message -H 'content-type: application/json' -d '{
  "chatId": "120363000000000000@g.us",
  "senderId": "15551230000@c.us",
  "senderName": "Marco D.",
  "chatName": "Watch Dealers NYC",
  "text": "FS Rolex Daytona 116500LN $18,500 CH",
  "isGroup": true
}'

curl -X POST localhost:3000/simulate/message -H 'content-type: application/json' -d '{
  "chatId": "15559990000@c.us",
  "senderId": "15559990000@c.us",
  "senderName": "James K.",
  "text": "WTB Rolex Daytona 116500LN $20,000",
  "isGroup": false
}'
```

With no `GREEN_API_ID_INSTANCE` configured, outbound DMs are logged to the
console instead of sent, so the whole pipeline is exercisable offline.

## Tests

```bash
npm test
```

Covers the listing parser and match-scoring logic (pure functions, no DB
required). The domain services that touch Postgres aren't unit tested here —
wire up a test database and exercise them via `/simulate/message` against a
running instance for integration-level coverage.

## Known limitations / next steps

- The listing parser is regex/keyword-based, not ML-based — it covers the
  dealer shorthand patterns from the landing page copy but will miss
  unusual phrasing. Extend `KNOWN_BRANDS`/`CONDITION_KEYWORDS`/patterns in
  `src/parsing/listingParser.ts` as real traffic reveals gaps.
- Review "chat history" scanning is a keyword heuristic
  (`src/domain/reviewService.ts`), not verified/moderated vouches.
- Telegram is mentioned on the landing page but out of scope here — this
  service is WhatsApp-only via Green API.
- No auth/admin UI yet for buying credit bundles; `grantCredits()` in
  `creditsService.ts` is the hook point for wiring up a payment webhook.
