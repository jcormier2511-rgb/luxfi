import { sendText } from "../channels";
import { PostingRow } from "./postingsStore";
import { claimPublication, eligiblePushGroups, finishPublication } from "./listingConfig";

export function formatGroupPosting(p:PostingRow):string {
  const fields=[p.type,[p.brand,p.model,p.reference].filter(Boolean).join(" "),p.dial&&`Dial: ${p.dial}`,p.condition&&`Condition: ${p.condition}`,p.price!==null&&`Price: ${p.currency} ${p.price}`,p.location&&`Location: ${p.location}`,p.box_papers&&`Box/Papers: ${p.box_papers}`,p.year&&`Year: ${p.year}`,p.original_text&&`Notes: ${p.original_text}`];
  return fields.filter(Boolean).join("\n");
}
export async function publishConfirmedListing(p:PostingRow):Promise<void>{for(const group of await eligiblePushGroups(p.type)){if(!await claimPublication(p.id,group.group_id))continue;try{await sendText(group.group_id,formatGroupPosting(p));await finishPublication(p.id,group.group_id,"posted");}catch(e){await finishPublication(p.id,group.group_id,"failed",(e as Error).message);}}}
