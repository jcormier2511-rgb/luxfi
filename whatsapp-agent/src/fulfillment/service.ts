import { sendText } from "../channels";
import { withSchema } from "../postings/db";
import { PostingRow } from "../postings/postingsStore";
import { runImmediateMatch } from "../postings/matching";
import { resolveNotifyIdentity } from "../postings/notificationPreferences";
import { isDealerOutreachSuppressed } from "../config";
import { freshInventorySql } from "../watchfacts/inventoryDb";
import { getValidatedListingUrl } from "../watchfacts/urlValidator";

const norm=(v:string)=>v.toLowerCase().replace(/[^a-z0-9]/g,'');
export function coverageMatches(c:{brand:string;model?:string;reference?:string;region?:string;min_budget?:number|null;max_budget?:number|null},w:Pick<PostingRow,'brand'|'model'|'reference'|'location'|'price'>):boolean{if(norm(c.brand)!==norm(w.brand)||Boolean(c.model)&&norm(c.model!)!==norm(w.model)||Boolean(c.reference)&&norm(c.reference!)!==norm(w.reference)||Boolean(c.region)&&norm(c.region!)!==norm(w.location))return false;const b=w.price===null?null:Number(w.price);return !(b!==null&&((c.min_budget!=null&&b<Number(c.min_budget))||(c.max_budget!=null&&b>Number(c.max_budget))));}

/** One orchestration boundary for all WTB sources. Explicit FS is always searched first. */
export async function fulfillWtb(wtb:PostingRow):Promise<{explicitMatches:number;opportunities:number;suppressed?:number}>{
  if(wtb.type!=='WTB')return {explicitMatches:0,opportunities:0};
  // The buyer's OWN search always runs. Suppression is about not reaching into other people's
  // inboxes from a test; it is never about giving the buyer a worse answer.
  const explicit=(await runImmediateMatch(wtb)).matchesFound;
  const candidates=await withSchema(async db=>{const coverage=(await db.query(`SELECT c.*,coalesce(p.wtb_alerts_paused,false) all_paused,'coverage' source,NULL::text source_inventory_id,NULL::text source_detail_url,NULL::text source_ref FROM wtb_coverage c LEFT JOIN canonical_notification_preferences p USING(canonical_user_id) WHERE c.status='active' AND coalesce(p.wtb_alerts_paused,false)=false`)).rows.filter(c=>coverageMatches(c,wtb));let known:any[]=[];try{known=(await db.query(`SELECT DISTINCT ON(li.canonical_user_id) li.canonical_user_id,i.external_id source_inventory_id,i.detail_url source_detail_url,i.ref source_ref,'known_inventory' source,NULL id FROM inventory_listings i JOIN linked_identities li ON regexp_replace(li.identity,'^(sms:)?\\+?','','i')=regexp_replace(i.contact_phone,'\\+','','g') LEFT JOIN canonical_notification_preferences p ON p.canonical_user_id=li.canonical_user_id WHERE i.is_active=true AND ${freshInventorySql('i')} AND i.type='FS' AND coalesce(p.wtb_alerts_paused,false)=false AND lower(i.brand)=lower($1) AND ($2='' OR i.ref='' OR regexp_replace(lower(i.ref),'[^a-z0-9]','','g')=regexp_replace(lower($2),'[^a-z0-9]','','g')) ORDER BY li.canonical_user_id,i.last_seen_at DESC`,[wtb.brand,wtb.reference])).rows}catch(e:any){if(e?.code!=='42P01')throw e;}const unique=new Map<number,any>();for(const c of [...known,...coverage])if(!unique.has(c.canonical_user_id))unique.set(c.canonical_user_id,c);return [...unique.values()]});
  // Dry run: report what real outreach would have done, and change nothing. Deliberately
  // BEFORE the claim, not just before the send -- claiming is the irreversible half. A dealer's
  // opportunity row is inserted ON CONFLICT DO NOTHING, so a claim taken during a test would
  // permanently stop that dealer ever being offered this WTB for real.
  if(isDealerOutreachSuppressed()){
    const would=candidates.filter(c=>c.canonical_user_id!==wtb.canonical_user_id);
    console.log(`[fulfillment] dealer outreach suppressed: ${would.length} dealer(s) would have been notified about posting ${wtb.id} (${wtb.brand}${wtb.reference?' '+wtb.reference:''}) — ${would.map(c=>`user ${c.canonical_user_id} via ${c.source}`).join(', ')||'none'}`);
    return {explicitMatches:explicit,opportunities:0,suppressed:would.length};
  }

  let opportunities=0;
  for(const c of candidates){
    if(c.canonical_user_id===wtb.canonical_user_id)continue;
    const claimed=await withSchema(async db=>(await db.query(`INSERT INTO wtb_fulfillment_opportunities(wtb_posting_id,dealer_canonical_user_id,source,source_inventory_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,[wtb.id,c.canonical_user_id,c.source,c.source_inventory_id])).rows[0]);
    if(!claimed)continue;
    // One dealer's broken/unregistered number must never take down notification for every
    // OTHER dealer, and must never propagate up into ingestDirectBuyPosting -- the live-reported
    // failure this fixes: a single candidate's sendText throwing (Whapi 404 "Channel not found")
    // crashed the whole request chain, so the BUYER who just typed "confirm" never got their own
    // "Your WTB request is active" acknowledgment either.
    try{
      const identity=await resolveNotifyIdentity(c.canonical_user_id);if(!identity)continue;
      const watch=[wtb.brand,wtb.model,wtb.reference].filter(Boolean).join(' ');
      // A dealer reached through known_inventory is being asked about a SPECIFIC listing of
      // their own -- the one whose brand/reference matched this buyer. Naming it and linking
      // it turns "can you fulfill this?" into a question they can answer without first working
      // out which of their pieces Fi means. Coverage-based candidates registered an interest
      // rather than a listing, so there is nothing to link and the block is omitted.
      // Validated for reachability like every other listing link Fi sends.
      const listingUrl=await getValidatedListingUrl(c.source_detail_url||undefined);
      const yours=listingUrl?`\n\nYour matching listing${c.source_ref?` (${c.source_ref})`:''}:\n${listingUrl}`:'';
      await sendText(identity,`New WTB opportunity — ${wtb.brand}\n\nBuyer is looking for:\n${watch}${wtb.price?`\nBudget: ${wtb.currency} ${Number(wtb.price).toLocaleString()}`:''}${wtb.location?`\n${wtb.location}`:''}${yours}\n\nCan you fulfill this request?\n\nReply:\nYES ${claimed.id}\nNO ${claimed.id}\nPAUSE ${wtb.brand}`);
      if(c.id)await withSchema(db=>db.query(`UPDATE wtb_coverage SET notification_count=notification_count+1,last_notification_at=now() WHERE id=$1`,[c.id]));
      opportunities++;
    }catch(err){
      console.error(`[fulfillment] failed to notify dealer ${c.canonical_user_id} of WTB opportunity ${claimed.id} for posting ${wtb.id}:`,err);
    }
  }
  return {explicitMatches:explicit,opportunities};
}

export async function listCoverageAdmin(){return withSchema(async db=>(await db.query(`SELECT c.id,c.canonical_user_id dealer,c.brand,coalesce(nullif(c.model,''),'ANY') model,coalesce(nullif(c.reference,''),'ANY') reference,c.region,c.min_budget,c.max_budget,c.status,c.cadence,c.last_notification_at,c.notification_count FROM wtb_coverage c ORDER BY c.brand,c.canonical_user_id`)).rows)}

export async function handleOpportunityResponse(identity:string,text:string):Promise<string|null>{
  const m=/^(YES|NO)\s+(\d+)$/i.exec(text.trim());if(!m)return null;
  const {getOrCreateCanonicalUser}=await import('../postings/identity');const {platformForIdentity}=await import('../channels');const user=await getOrCreateCanonicalUser(platformForIdentity(identity),identity);
  const row=await withSchema(async db=>(await db.query(`UPDATE wtb_fulfillment_opportunities SET status=$1,responded_at=now() WHERE id=$2 AND dealer_canonical_user_id=$3 AND status='pending' RETURNING *`,[m[1].toUpperCase()==='YES'?'accepted':'declined',Number(m[2]),user])).rows[0]);
  if(!row)return 'That opportunity is no longer pending.';
  return m[1].toUpperCase()==='NO'?'Declined. You will still receive future matching WTB opportunities.':'Great — what is your asking price? Include currency, exact reference, condition, and location where available. This will remain a private fulfillment offer.';
}
