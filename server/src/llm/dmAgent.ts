import { z } from "zod";
import type { Dealer } from "@prisma/client";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { anthropic, LLM_MODEL } from "./client.js";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { findDealerByNameLike } from "../domain/dealerService.js";
import { fulfillVouchRequest, getPendingVouchRequest, getReviewProfile, requestVouch } from "../domain/reviewService.js";
import { sendDirectMessage } from "../green-api/client.js";
import { formatVouchReceivedNotice, formatVouchRequestToTarget } from "../messaging/templates.js";

/**
 * Fi's conversational side: a DM to Fi is handled by Claude directly, rather
 * than a fixed command grammar. Claude decides whether the dealer's message
 * calls for looking up a counterparty's reviews, requesting a vouch, or
 * recording one, and writes the reply itself — grounded in real account data
 * passed through tool results and system-prompt context (never invented).
 */
export async function handleDmMessage(sender: Dealer, text: string): Promise<string> {
  const pendingVouch = await getPendingVouchRequest(sender.id);
  const requester = pendingVouch ? await prisma.dealer.findUnique({ where: { id: pendingVouch.requesterDealerId } }) : null;

  const checkDealerReviewsTool = betaZodTool({
    name: "check_dealer_reviews",
    description: "Look up a dealer's review/vouch profile by name or handle. Use when the sender asks about another dealer's reputation or reviews.",
    inputSchema: z.object({ dealerName: z.string().describe("Name or handle of the dealer to look up") }),
    run: async ({ dealerName }) => {
      const target = await findDealerByNameLike(dealerName);
      if (!target) return JSON.stringify({ found: false, dealerName });
      const profile = await getReviewProfile(target.id);
      return JSON.stringify({
        found: true,
        name: profile.dealer.name,
        trustTier: profile.dealer.trustTier,
        vouchCount: profile.dealer.vouchCount,
        avgRating: profile.avgRating,
        recentReviews: profile.recentReviews.map((r) => ({ rating: r.rating, text: r.text })),
      });
    },
  });

  const requestVouchTool = betaZodTool({
    name: "request_vouch",
    description: "Ask another dealer to leave a review/vouch for the sender about a specific deal. Use when the sender asks to request a review/vouch from someone.",
    inputSchema: z.object({
      dealerName: z.string().describe("Name or handle of the dealer being asked to vouch"),
      dealDescription: z.string().nullable().describe("Short description of the deal, e.g. 'Daytona 116500LN', or null if not mentioned"),
    }),
    run: async ({ dealerName, dealDescription }) => {
      const target = await findDealerByNameLike(dealerName);
      if (!target) return JSON.stringify({ ok: false, reason: "dealer_not_found", dealerName });

      await requestVouch(sender, target, dealDescription ?? null);
      await sendDirectMessage(target.whatsappId, formatVouchRequestToTarget(sender.name ?? "A dealer", dealDescription ?? null));
      return JSON.stringify({ ok: true, targetName: target.name ?? dealerName });
    },
  });

  const recordVouchTool = betaZodTool({
    name: "record_vouch",
    description: pendingVouch
      ? `The sender has a PENDING vouch request from ${requester?.name ?? "a dealer"} about "${pendingVouch.dealText ?? "a recent deal"}". Call this if their message reads like a rating/review reply to that request.`
      : "Not applicable right now — there is no pending vouch request for this sender. Do not call this tool.",
    inputSchema: z.object({
      rating: z.number().int().min(1).max(5).nullable().describe("1-5 rating if the sender gave one, else null"),
      comment: z.string().describe("Their comment/review text"),
    }),
    run: async ({ rating, comment }) => {
      if (!pendingVouch) return JSON.stringify({ ok: false, reason: "no_pending_request" });

      await fulfillVouchRequest(pendingVouch, sender.id, rating, comment);
      if (requester) {
        await sendDirectMessage(requester.whatsappId, formatVouchReceivedNotice(sender.name ?? "a dealer", rating));
      }
      return JSON.stringify({ ok: true });
    },
  });

  const freeMatchesLeft = Math.max(0, config.matching.freeMatchesPerDealer - sender.freeMatchesUsed);

  const systemPrompt = `You are Fi, LuxFi's WhatsApp agent for a network of luxury dealers (watches, handbags, jewelry). You're DMing ${sender.name ?? "this dealer"} directly right now — Fi never posts in groups, only 1:1.

What Fi does: silently monitors dealer WhatsApp groups for WTB ("want to buy") and FS ("for sale") posts, matches buyers to sellers across the whole network, and DMs both sides a match with a review summary of the counterparty. Each verified match costs 15 credits per side; a dealer's first 3 matches are free.

Ground truth for this conversation — only state figures that come from here or a tool result, never invent one:
- Credit balance: ${sender.credits}
- Free matches remaining: ${freeMatchesLeft}
${pendingVouch ? `- Pending vouch request from ${requester?.name ?? "a dealer"} about "${pendingVouch.dealText ?? "a recent deal"}" — if this message is their rating/review reply to it, call record_vouch.` : ""}

Use check_dealer_reviews / request_vouch / record_vouch when the dealer's message calls for that action. Otherwise (greetings, questions about how Fi works, their own balance, general chat) just reply directly using the context above. Keep replies WhatsApp-short — 1-3 sentences, professional but warm.`;

  const runner = anthropic.beta.messages.toolRunner({
    model: LLM_MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    tools: [checkDealerReviewsTool, requestVouchTool, recordVouchTool],
    messages: [{ role: "user", content: text }],
  });

  const finalMessage = await runner;
  const replyText = finalMessage.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  return replyText || "Got it.";
}
