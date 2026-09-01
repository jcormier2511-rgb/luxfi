import { config } from "../config";
import { initAdminSchema } from "../admin/store";
import { withSchema } from "../postings/db";
import { sendTemplate } from "../whapi/client";
import { MEMBERSHIP_PLANS } from "../billing/plans";

export const FI_RETURNING_PROMOTIONAL_TASKS = 3;

export function formatFiReturningMessage(firstName: string | null, publicNumber = config.fiReturningCampaign.publicPhoneNumber): string {
  if (!publicNumber) throw new Error("FI_PUBLIC_PHONE_NUMBER is required");
  const greeting = firstName?.trim() ? `Hi ${firstName.trim().split(/\s+/)[0]}, Fi here.` : "Hi, Fi here.";
  const price = `${MEMBERSHIP_PLANS.tier1.priceLabel} flat rate`;
  return `${greeting} Sorry I’ve been away for a bit. I’ve been getting some major upgrades behind the scenes, and I’m back—new number, new capabilities, and better than ever.\n\n` +
    `I now work 24/7 to help you find buyers, find sellers, monitor your WTB and FS listings, and connect you with opportunities across the dealer network.\n\n` +
    `Please save my new number: ${publicNumber}\n\nTo welcome you back, your next 3 tasks are on me. Give me a try and put the new Fi to work.\n\n` +
    `After that, we’ve simplified pricing to just ${price}.\n\nThanks for your patience. I think the new Fi was worth the wait.\n\n` +
    `Just tell me what you want to buy or sell and I’ll get to work.`;
}

type Candidate = { canonical_user_id:number; identity:string; first_name:string|null; access_status:string|null; opt_in_status:string|null; last_direct_inbound_at:string|null; delivery_status:string|null };
export type ExclusionReason = "no_direct_history"|"invalid_phone"|"blocked"|"opted_out"|"already_sent";
export type CampaignPreview = { eligible:number; alreadySent:number; excluded:number; exclusions:Record<ExclusionReason,number> };
export type CampaignResult = CampaignPreview & { attempted:number; sent:number; failed:number; skipped:number; dryRun:boolean };

const validPhone=(phone:string)=>/^[1-9][0-9]{7,14}$/.test(phone.replace(/\D/g,""));
function exclusion(c:Candidate):ExclusionReason|null {
  if (c.delivery_status === "sent") return "already_sent";
  if (["blocked","inactive"].includes(c.access_status ?? "")) return "blocked";
  if (c.opt_in_status === "opted_out") return "opted_out";
  if (!validPhone(c.identity)) return "invalid_phone";
  if (!c.last_direct_inbound_at) return "no_direct_history";
  return null;
}

async function candidates():Promise<Candidate[]> {
  await initAdminSchema();
  return withSchema(async db => (await db.query(`SELECT cu.id canonical_user_id,li.identity,l.first_name,l.last_direct_inbound_at,
    au.access_status,au.opt_in_status,d.status delivery_status
    FROM canonical_users cu JOIN linked_identities li ON li.canonical_user_id=cu.id AND li.platform='whatsapp'
    LEFT JOIN user_lifecycle l ON l.canonical_user_id=cu.id
    LEFT JOIN approved_users au ON regexp_replace(au.phone,'[^0-9]','','g')=regexp_replace(li.identity,'[^0-9]','','g')
    LEFT JOIN fi_returning_campaign_deliveries d ON d.canonical_user_id=cu.id`)).rows);
}

function summarize(rows:Candidate[]):CampaignPreview {
  const exclusions:Record<ExclusionReason,number>={no_direct_history:0,invalid_phone:0,blocked:0,opted_out:0,already_sent:0}; let eligible=0;
  for(const row of rows){const reason=exclusion(row);if(reason)exclusions[reason]++;else eligible++;}
  return {eligible,alreadySent:exclusions.already_sent,excluded:rows.length-eligible-exclusions.already_sent,exclusions};
}

export async function previewFiReturningCampaign():Promise<CampaignPreview>{return summarize(await candidates());}

export interface RunOptions { dryRun?:boolean; testRecipient?:string; send?:typeof sendTemplate; delay?: (ms:number)=>Promise<void> }
export async function runFiReturningCampaign(options:RunOptions={}):Promise<CampaignResult>{
  if(!config.fiReturningCampaign.publicPhoneNumber) throw new Error("FI_PUBLIC_PHONE_NUMBER is required");
  const rows=await candidates(), preview=summarize(rows); const normalizedTest=options.testRecipient?.replace(/\D/g,"");
  let attempted=0,sent=0,failed=0,skipped=0;
  for(const row of rows){
    const excluded=exclusion(row);
    if(excluded){skipped++;console.info("[fi-returning-campaign]",{status:"skipped",recipientAccountId:row.canonical_user_id,reason:excluded,timestamp:new Date().toISOString()});continue;}
    if(normalizedTest && row.identity.replace(/\D/g,"")!==normalizedTest){skipped++;console.info("[fi-returning-campaign]",{status:"skipped",recipientAccountId:row.canonical_user_id,reason:"test_recipient_filter",timestamp:new Date().toISOString()});continue;}
    if(options.dryRun) continue;
    const claimed=await withSchema(async db=>(await db.query(`INSERT INTO fi_returning_campaign_deliveries(canonical_user_id,recipient_identity,status,reason)
      VALUES($1,$2,'attempted',NULL) ON CONFLICT(canonical_user_id) DO UPDATE SET status='attempted',reason=NULL,attempted_at=now(),updated_at=now()
      WHERE fi_returning_campaign_deliveries.status='failed' RETURNING canonical_user_id`,[row.canonical_user_id,row.identity])).rowCount===1);
    if(!claimed){skipped++;console.info("[fi-returning-campaign]",{status:"skipped",recipientAccountId:row.canonical_user_id,reason:"already_claimed",timestamp:new Date().toISOString()});continue;} attempted++;
    console.info("[fi-returning-campaign]",{status:"attempted",recipientAccountId:row.canonical_user_id,timestamp:new Date().toISOString()});
    try{
      const first=row.first_name?.trim().split(/\s+/)[0]||null;
      const greeting=first?`Hi ${first}, Fi here.`:"Hi, Fi here.";
      await (options.send??sendTemplate)(row.identity,config.fiReturningCampaign.templateName,config.fiReturningCampaign.templateLanguage,[greeting,config.fiReturningCampaign.publicPhoneNumber],formatFiReturningMessage(first));
      await withSchema(async db=>{await db.query("BEGIN");try{
        await db.query(`INSERT INTO fi_returning_promotions(canonical_user_id,tasks_granted,tasks_used,campaign_sent_at) VALUES($1,3,0,now()) ON CONFLICT(canonical_user_id) DO NOTHING`,[row.canonical_user_id]);
        await db.query(`UPDATE fi_returning_campaign_deliveries SET status='sent',sent_at=now(),updated_at=now() WHERE canonical_user_id=$1`,[row.canonical_user_id]);await db.query("COMMIT");
      }catch(e){await db.query("ROLLBACK");throw e;}}); sent++; console.info("[fi-returning-campaign]",{status:"sent",recipientAccountId:row.canonical_user_id,timestamp:new Date().toISOString()});
    }catch(error){failed++;const reason=error instanceof Error?error.message.slice(0,500):"delivery failed";await withSchema(db=>db.query(`UPDATE fi_returning_campaign_deliveries SET status='failed',reason=$2,updated_at=now() WHERE canonical_user_id=$1`,[row.canonical_user_id,reason]));console.error("[fi-returning-campaign]",{status:"failed",recipientAccountId:row.canonical_user_id,reason,timestamp:new Date().toISOString()});}
    const delayMs=config.fiReturningCampaign.ratePerHour>0?Math.ceil(3600000/config.fiReturningCampaign.ratePerHour):0;if(delayMs&&(sent+failed)<preview.eligible)await (options.delay??((ms)=>new Promise(r=>setTimeout(r,ms))))(delayMs);
  }
  return {...preview,attempted,sent,failed,skipped,dryRun:Boolean(options.dryRun)};
}
