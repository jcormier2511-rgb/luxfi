import { withSchema } from "../postings/db";
import { getOrCreateCanonicalUser } from "../postings/identity";
import { platformForIdentity } from "../channels";

const clean=(v:string)=>v.trim().replace(/\s+/g," ");
export async function upsertCoverage(identity:string, brand:string, model="", reference="") {
  const user=await getOrCreateCanonicalUser(platformForIdentity(identity),identity);
  return withSchema(async db=>(await db.query(`INSERT INTO wtb_coverage(canonical_user_id,brand,model,reference,status)
    VALUES($1,$2,$3,$4,'active') ON CONFLICT(canonical_user_id,brand,model,reference)
    DO UPDATE SET status='active',updated_at=now() RETURNING *`,[user,clean(brand),clean(model),clean(reference)])).rows[0]);
}
export async function setCoverageStatus(identity:string,brand:string,status:'active'|'paused'|'removed') {
  const user=await getOrCreateCanonicalUser(platformForIdentity(identity),identity);
  return withSchema(async db=>status==='removed'
    ? (await db.query(`DELETE FROM wtb_coverage WHERE canonical_user_id=$1 AND lower(brand)=lower($2)`,[user,clean(brand)])).rowCount
    : (await db.query(`UPDATE wtb_coverage SET status=$3,updated_at=now() WHERE canonical_user_id=$1 AND lower(brand)=lower($2)`,[user,clean(brand),status])).rowCount);
}
export async function setAllAlerts(identity:string,paused:boolean){const user=await getOrCreateCanonicalUser(platformForIdentity(identity),identity);await withSchema(db=>db.query(`INSERT INTO canonical_notification_preferences(canonical_user_id,wtb_alerts_paused) VALUES($1,$2) ON CONFLICT(canonical_user_id) DO UPDATE SET wtb_alerts_paused=$2`,[user,paused]));}
export async function listCoverage(identity:string){const user=await getOrCreateCanonicalUser(platformForIdentity(identity),identity);return withSchema(async db=>(await db.query(`SELECT * FROM wtb_coverage WHERE canonical_user_id=$1 ORDER BY brand,model,reference`,[user])).rows);}

export async function handleCoverageCommand(identity:string,text:string):Promise<string|null>{
  const t=text.trim(); let m:RegExpExecArray|null;
  if((m=/^(?:send me all|i handle all)\s+(.+?)(?:\s+(?:wtbs|inquiries))?$/i.exec(t))) {await upsertCoverage(identity,m[1]);return `Done — ACTIVE coverage for ${clean(m[1])}, model ANY, reference ANY.`;}
  // "pause"/"resume"/"remove" are also listing-management verbs (see conversation/flow.ts's
  // parseListingEditCommand), and this runs BEFORE that in server.ts's routing -- a bare
  // brand-name capture here previously swallowed "pause listing 1", "remove #1 and 2", etc.
  // before the real listing-management handler ever saw them, silently reporting a coverage
  // change for a "brand" like "listing 1" or "#1 and 2" that never actually matched any alert.
  // A target that's a listing reference (digits, "#", or the word "listing") is never a brand
  // name, so it's left for flow.ts to handle instead.
  if((m=/^(pause|resume|remove)\s+(.+?)(?:\s+(?:coverage|alerts?))?$/i.exec(t))&&!/^#?\d|^listings?\b/i.test(m[2].trim())){await setCoverageStatus(identity,m[2],m[1].toLowerCase()==='pause'?'paused':m[1].toLowerCase()==='remove'?'removed':'active');return `${m[1][0].toUpperCase()+m[1].slice(1).toLowerCase()}d ${clean(m[2])} WTB coverage.`;}
  if(/^stop\s+.+\s+alerts?$/i.test(t)){const brand=t.replace(/^stop\s+/i,'').replace(/\s+alerts?$/i,'');await setCoverageStatus(identity,brand,'removed');return `Stopped ${brand} WTB alerts.`;}
  if(/^pause all wtb alerts$/i.test(t)){await setAllAlerts(identity,true);return 'All WTB alerts paused.';}
  if(/^resume all wtb alerts$/i.test(t)){await setAllAlerts(identity,false);return 'All WTB alerts resumed.';}
  if(/^show my wtb alerts$/i.test(t)){const rows=await listCoverage(identity);return rows.length?rows.map(r=>`${r.brand} — ${r.model||'ANY'} / ${r.reference||'ANY'} — ${r.status.toUpperCase()} — ${r.cadence}`).join('\n'):'You have no WTB coverage alerts.';}
  return null;
}
