#!/usr/bin/env bash
# Sends a battery of test messages through /simulate/message to exercise Fi's
# LLM-driven understanding — both the tricky group-message classification
# cases and a full DM conversation. Requires:
#   - the server running with ENABLE_DEV_SIMULATE=true and a real ANTHROPIC_API_KEY
#   - `jq` installed (brew install jq / apt install jq) for readable output
#
# Usage: ./scripts/test-prompts.sh [base_url]   (default http://localhost:3000)

set -euo pipefail
BASE_URL="${1:-http://localhost:3000}"

post() {
  curl -s -X POST "$BASE_URL/simulate/message" -H 'content-type: application/json' -d "$1"
}

section() { echo; echo "=== $1 ==="; }
send() {
  local label="$1" payload="$2"
  echo "-> $label"
  post "$payload" | (command -v jq >/dev/null && jq . || cat)
  sleep 0.3
}

GROUP_NYC='"chatId":"120363000000000001@g.us","chatName":"Watch Dealers NYC"'
GROUP_MIA='"chatId":"120363000000000002@g.us","chatName":"Watch Dealers Miami"'
SELLER='"senderId":"15551230000@c.us","senderName":"Marco D."'
BUYER='"senderId":"15559990000@c.us","senderName":"James K."'

section "Clean listings — should extract cleanly and (2nd one) trigger a match"
send "FS, clear listing" "{$GROUP_NYC,$SELLER,\"text\":\"FS Rolex Daytona 116500LN \$18,500 CH\",\"isGroup\":true}"
send "WTB, clear listing (should match the FS above)" "{$GROUP_MIA,$BUYER,\"text\":\"WTB Rolex Daytona 116500LN \$20,000\",\"isGroup\":true}"

section "Should NOT be parsed as listings (chatter / questions / negotiation)"
send "plain chatter" "{$GROUP_NYC,$SELLER,\"text\":\"anyone around this weekend?\",\"isGroup\":true}"
send "a question about a brand, not a listing" "{$GROUP_NYC,$SELLER,\"text\":\"does anyone know if the new Daytona ref is out yet?\",\"isGroup\":true}"
send "negotiation reply referencing a listing" "{$GROUP_MIA,$BUYER,\"text\":\"can you do \$19k on that Daytona?\",\"isGroup\":true}"
send "a reply confirming a deal, not a new post" "{$GROUP_NYC,$SELLER,\"text\":\"sounds good, sending payment now\",\"isGroup\":true}"

section "Unusual phrasing — tests whether extraction is robust to non-template posts"
send "ISO phrasing, no dollar sign" "{$GROUP_MIA,$BUYER,\"text\":\"ISO AP Royal Oak 15400ST, budget around 25k, NYC preferred\",\"isGroup\":true}"
send "conversational FS with alias brand" "{$GROUP_NYC,$SELLER,\"text\":\"selling my Patek 5711/1A, mint condition, box and papers, asking 145k\",\"isGroup\":true}"
send "handbag category (tests category classification)" "{$GROUP_NYC,$SELLER,\"text\":\"FS Hermes Birkin 30 Togo Gold hardware \$16,000\",\"isGroup\":true}"

section "Photo + caption — triggers the authenticity check (needs a reachable image URL)"
send "FS with photo" "{$GROUP_NYC,$SELLER,\"text\":\"FS Rolex Submariner 126610LN \$13,900 full set\",\"imageUrl\":\"https://upload.wikimedia.org/wikipedia/commons/e/e9/Rolex_Submariner_Date_116610LN.jpg\",\"isGroup\":true}"

section "DM conversation with Fi (as the buyer, James K.)"
send "greeting" "{$BUYER,\"chatId\":\"15559990000@c.us\",\"text\":\"hey what can you do?\",\"isGroup\":false}"
send "balance question" "{$BUYER,\"chatId\":\"15559990000@c.us\",\"text\":\"what's my credit balance?\",\"isGroup\":false}"
send "check reviews, natural phrasing" "{$BUYER,\"chatId\":\"15559990000@c.us\",\"text\":\"has anyone dealt with Marco before? is he legit?\",\"isGroup\":false}"
send "request a vouch, natural phrasing" "{$BUYER,\"chatId\":\"15559990000@c.us\",\"text\":\"can you ask Marco to vouch for me for that Daytona deal we just did\",\"isGroup\":false}"

section "DM conversation with Fi (as the seller, Marco D. — should see the pending vouch request)"
send "off-topic reply, should NOT be treated as a vouch" "{$SELLER,\"chatId\":\"15551230000@c.us\",\"text\":\"who is this\",\"isGroup\":false}"
send "actual vouch reply" "{$SELLER,\"chatId\":\"15551230000@c.us\",\"text\":\"James was great, fast payment and easy to deal with, 5 stars\",\"isGroup\":false}"

echo
echo "Done. Read through each response — for group messages, check the server log (not this output) for Fi's DMs to the dealers involved."
