# Fi — LuxFi's WhatsApp agent

Backend for Fi, the agent described on the LuxFi landing page (`../index.html`):
it sits silently in dealer WhatsApp groups, captures WTB ("want to buy") and
FS ("for sale") posts, matches them across the network, pulls a review
profile on the counterparty before notifying either side, and charges
credits per verified match. Fi's understanding of messages and its DM
conversations are driven by Claude, not a fixed keyword grammar.

## How it works

1. **Green API webhook** (`POST /webhook/green-api`) receives every message
   Fi's WhatsApp number can see — both group messages and 1:1 DMs sent to Fi.
2. **Group messages** are read by Claude (`src/llm/listingExtractor.ts`),
   which decides whether the message is a WTB/FS post and extracts brand,
   reference, price, condition, category, and location as structured output —
   ordinary chatter, questions, and negotiation replies come back as "not a
   listing" instead of being misparsed. A hit becomes a `Listing` row and is
   run through the matcher (`src/domain/matchingService.ts`). Fi **never
   posts back into the group** — it only reads. All notifications go out as
   1:1 DMs to the two dealers involved.
3. **Matching** (`src/matching/scoreMatch.ts`) requires the brand to match
   on both sides, scores reference/price/location, and rejects the pair if
   the seller's ask is well above the buyer's stated max.
4. **Credits** (`src/domain/creditsService.ts`): each dealer's first 3
   matches are free; after that, 15 credits are charged per side per match.
   If either dealer can't afford it, Fi DMs them to top up and leaves both
   listings open for a future match instead of charging.
5. **DMs to Fi** are handled entirely by Claude (`src/llm/dmAgent.ts`) —
   there's no command grammar to match against. Claude gets the dealer's real
   credit balance, free-match count, and any pending vouch request as system
   context, plus three tools it can call when the conversation calls for it:
   `check_dealer_reviews`, `request_vouch`, and `record_vouch` (for replying
   to a vouch request with a rating). Anything else — greetings, "how does
   this work", asking their own balance — Claude just answers directly from
   the context it was given. It never invents a credit number, rating, or
   vouch count that didn't come from a tool result or the context block.
6. **Reviews** (`src/domain/reviewService.ts`): before a match is delivered,
   Fi looks up the counterparty's on-file reviews, or — if none exist yet —
   heuristically scans stored group chat history for vouch-like mentions of
   that dealer's name.

## Setup

```bash
cp .env.example .env    # fill in DATABASE_URL, ANTHROPIC_API_KEY, and Green API credentials
npm install
npm run prisma:generate
npm run prisma:migrate  # creates the schema in DATABASE_URL
npm run dev
```

### Claude (required)

Fi's message understanding and DM replies require `ANTHROPIC_API_KEY` in
`.env`. Without it, every request to `src/llm/*` fails and Fi won't parse
listings or respond to DMs. `LLM_MODEL` defaults to `claude-opus-5`; override
it (e.g. to a Sonnet/Haiku model) if you want to trade quality for lower
per-message cost at scale — a dealer-group bot can see a lot of chatter, and
every group message triggers one classification call.

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

Set `ENABLE_DEV_SIMULATE=true` and POST synthetic messages (still requires a
real `ANTHROPIC_API_KEY` — Fi's understanding runs through Claude even in
dev):

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
console instead of sent, so the WhatsApp transport itself is exercisable
offline — but the LLM calls always hit the real API.

## Tests

```bash
npm test
```

Covers match-scoring (pure logic, no DB or network) and the listing
extractor's adapter logic against a mocked Anthropic client (verifies the
`parsed_output` -> `ExtractedListing` mapping and the empty-input short
circuit, without calling the real API). The domain services that touch
Postgres, and the DM agent's actual tool-calling behavior, aren't unit
tested here — wire up a test database and a real `ANTHROPIC_API_KEY` and
exercise them via `/simulate/message` against a running instance for
integration-level coverage.

## Known limitations / next steps

- Every group message costs one Claude call to classify; at high group
  volume, consider batching, a cheaper `LLM_MODEL`, or a cheap local
  pre-filter before the LLM call if cost becomes a concern.
- Review "chat history" scanning is a keyword heuristic
  (`src/domain/reviewService.ts`), not verified/moderated vouches.
- Telegram is mentioned on the landing page but out of scope here — this
  service is WhatsApp-only via Green API.
- No auth/admin UI yet for buying credit bundles; `grantCredits()` in
  `creditsService.ts` is the hook point for wiring up a payment webhook.
