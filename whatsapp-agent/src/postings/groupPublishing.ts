import { sendText, sendBannerImage } from "../channels";
import { sendGroupText as greenApiSendGroupText, sendGroupBannerImage as greenApiSendGroupBannerImage } from "../channels/greenApi";
import { PostingRow, getPrimaryImageUrl } from "./postingsStore";
import { claimPublication, eligiblePushGroups, finishPublication } from "./listingConfig";

export function formatGroupPosting(p:PostingRow):string {
  const fields=[p.type,[p.brand,p.model,p.reference].filter(Boolean).join(" "),p.dial&&`Dial: ${p.dial}`,p.condition&&`Condition: ${p.condition}`,p.price!==null&&`Price: ${p.currency} ${p.price}`,p.location&&`Location: ${p.location}`,p.box_papers&&`Box/Papers: ${p.box_papers}`,p.year&&`Year: ${p.year}`,p.original_text&&`Notes: ${p.original_text}`];
  return fields.filter(Boolean).join("\n");
}

// Same safety margin as the seller-confirmation photo-caption path (server.ts's webhook
// dispatch) -- Telegram hard-caps a photo caption at 1024 characters; a long listing (extra
// fields, a long free-text note) falls back to plain text rather than risk a provider silently
// truncating or rejecting an oversized caption.
const MAX_CAPTION_LENGTH = 1000;

/** Fetched once per listing, not once per group -- every eligible group gets the same photo. */
export async function publishConfirmedListing(p:PostingRow):Promise<void>{
  const imageUrl = await getPrimaryImageUrl(p.id).catch(()=>null);
  for(const group of await eligiblePushGroups(p.type)){
    if(!await claimPublication(p.id,group.group_id))continue;
    try{
      const text=formatGroupPosting(p);
      const useImage = Boolean(imageUrl) && text.length<=MAX_CAPTION_LENGTH;
      // A WhatsApp GROUP send needs the "@g.us" chatId form Green API's group-specific
      // sendGroupText/sendGroupBannerImage build (see channels/greenApi.ts) -- channels/index.ts's
      // generic dispatch always builds the INDIVIDUAL "@c.us" form instead, since every other
      // caller only ever sends to a real 1:1 contact. A Telegram group keeps going through the
      // existing channels/index.ts dispatch, unchanged -- Telegram has no such split.
      if (group.platform === "whatsapp") {
        if (useImage) await greenApiSendGroupBannerImage(group.group_id, imageUrl!, text);
        else await greenApiSendGroupText(group.group_id, text);
      } else {
        if (useImage) await sendBannerImage(group.group_id, imageUrl!, text);
        else await sendText(group.group_id, text);
      }
      await finishPublication(p.id,group.group_id,"posted");
    }catch(e){await finishPublication(p.id,group.group_id,"failed",(e as Error).message);}
  }
}
