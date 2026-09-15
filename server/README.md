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
7. **Authenticity and price checks** (`src/domain/verificationService.ts`)
   run once, in parallel, right after a listing is created — never gating
   the match, just surfaced as an advisory line on the notification:
   - If the dealer posted a photo with their listing (a captioned WhatsApp
     image), Claude looks at it (`src/llm/authenticityChecker.ts`) for
     visual authenticity red flags — proportions, engraving/font quality,
     stock-photo tells. It defaults to "inconclusive" whenever the photo
     doesn't show enough to judge, rather than a false accusation.
   - Every listing with a stated price gets checked against current
     secondary-market pricing via Claude + web search
     (`src/llm/priceChecker.ts`) — flagging "below market" (a common scam
     signal) or "above market".

## Advisory checks, not gates

Both the review lookup and the authenticity/price checks are informational —
none of them block a match or the credit charge. They're LLM-driven signals
for a human dealer to weigh, not verified facts; a wrong "possible_concern"
or "below_market" call is a false-positive risk you should expect and design
around (e.g., dealers can always ask Fi to re-check or ignore the flag).

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

### Green API — connecting Fi to a real WhatsApp number

Green API is an unofficial provider: it links to a real WhatsApp account the
same way WhatsApp Web/Desktop does (a "linked device"), not Meta's official
Business Platform. That means **Fi needs its own phone number** — one that
isn't already active in WhatsApp elsewhere, since linking it hands that
number's WhatsApp session to Green API. Because this automates a real
client, WhatsApp can in principle flag and ban the number for bot-like
behavior — **use a spare/burner number for Fi, never your personal one.**

1. **Get a number.** Any number that can receive WhatsApp's SMS/call
   verification and isn't already registered elsewhere — a spare SIM, a
   second line, a prepaid SIM all work.
2. **Create the instance.** Sign up at https://console.green-api.com and
   create an instance. Copy the `idInstance` / `apiTokenInstance` it gives
   you into `.env`.
3. **Link the number.** Install WhatsApp on a phone using that number and
   register it normally. Then in that WhatsApp app: **Settings → Linked
   Devices → Link a Device**, and scan the QR code shown in the Green API
   console for your instance. Once the console shows the instance as
   "authorized," Green API is acting as a linked device on that WhatsApp
   account — this is how Fi stays silent per the landing page copy: it's a
   real participant in a chat, not a bot with special posting privileges.
4. **Expose your server publicly.** Green API needs to `POST` webhooks to a
   real HTTPS URL — `localhost` doesn't work. For local testing, tunnel it:
   ```bash
   npx ngrok http 3000
   ```
   That prints a URL like `https://abc123.ngrok-free.app`. (For a real
   deployment, use wherever you host `server/` instead of a tunnel.)
5. **Wire it together.** With `ANTHROPIC_API_KEY` and the Green API
   credentials in `.env`, in the Green API console set the instance's
   webhook URL to `https://<your-tunnel-or-host>/webhook/green-api` (append
   `?token=<WEBHOOK_TOKEN>` if you set one) and enable
   `incomingMessageReceived`. Then `npm run dev`.
6. **Test it for real:**
   - DM Fi's number directly from your own phone — you should get a real
     conversational reply routed through `src/llm/dmAgent.ts`.
   - Create or use a test WhatsApp group, add Fi's number as a normal
     participant, and have two different numbers post a matching WTB and FS
     — Fi should silently pick both up and DM each side a match.
   - Once you're confident it's working, add Fi's number to real dealer
     groups the same way — no group-admin action needed beyond adding it as
     a participant.

Once Fi's real number is live, update the placeholder `wa.me/923156320997`
links in `../index.html` to point at it.

### Local testing without live WhatsApp

Set `ENABLE_DEV_SIMULATE=true` and POST synthetic messages (still requires a
real `ANTHROPIC_API_KEY` — Fi's understanding runs through Claude even in
dev). `scripts/test-prompts.sh` runs a broader battery of these — clean
listings, chatter/negotiation that should *not* be parsed as listings,
unusual phrasing, a handbag listing, a photo, and a full DM conversation
including the vouch-request loop — useful for judging prompt quality before
you go live:

```bash
./scripts/test-prompts.sh
```

Or send one-off messages by hand:

```bash
curl -X POST localhost:3000/simulate/message -H 'content-type: application/json' -d '{
  "chatId": "120363000000000000@g.us",
  "senderId": "15551230000@c.us",
  "senderName": "Marco D.",
  "chatName": "Watch Dealers NYC",
  "text": "FS Rolex Daytona 116500LN $18,500 CH",
  "isGroup": true
}'

# Same, with a photo attached — triggers the authenticity check too
curl -X POST localhost:3000/simulate/message -H 'content-type: application/json' -d '{
  "chatId": "120363000000000000@g.us",
  "senderId": "15551230000@c.us",
  "senderName": "Marco D.",
  "chatName": "Watch Dealers NYC",
  "text": "FS Rolex Daytona 116500LN $18,500 CH",
  "imageUrl": "https://example.com/watch-photo.jpg",
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

- Every group message costs one Claude call to classify, and every listing
  with a price costs a second call with web search for the price check
  (plus a third, vision, call if a photo was attached). At high group
  volume, consider batching, a cheaper `LLM_MODEL`, or a cheap local
  pre-filter before the classification call if cost becomes a concern.
- The Green API webhook shape assumed for photo messages
  (`messageData.fileMessageData.downloadUrl`/`.caption`) is based on Green
  API's documented notification format but hasn't been verified against a
  live instance — check it against a real webhook payload before relying on
  the authenticity check in production.
- Authenticity and price checks are advisory signals, not verified facts —
  see "Advisory checks, not gates" above.
- Review "chat history" scanning is a keyword heuristic
  (`src/domain/reviewService.ts`), not verified/moderated vouches.
- Telegram is mentioned on the landing page but out of scope here — this
  service is WhatsApp-only via Green API.
- No auth/admin UI yet for buying credit bundles; `grantCredits()` in
  `creditsService.ts` is the hook point for wiring up a payment webhook.
