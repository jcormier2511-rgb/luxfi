import { withSchema, withTransaction } from "./db";
import { PostingRow } from "./postingsStore";

export const MORE_COMMAND = /^(?:more|show me more|more listings|more matches)[.!?\s]*$/i;
export const MORE_NO_CONTEXT = "I don’t have a recent WatchFacts match to expand. Send me what you want to buy or sell and I’ll search for it.";

export interface MoreContext {
  canonical_user_id:number; channel:string; originating_group_id:string; originating_posting_id:number;
  posting_side:"FS"|"WTB"; brand:string; model:string; reference:string; dial:string; condition:string;
  price:string|null; presented_match_id:number; presented_candidate_posting_id:number; created_at:string;
}

async function ready():Promise<void>{
  await withTransaction(async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtext('luxfi_more_context_schema'))");
    await client.query(`CREATE TABLE IF NOT EXISTS group_match_more_contexts (
      id BIGSERIAL PRIMARY KEY, canonical_user_id INTEGER NOT NULL REFERENCES canonical_users(id),
      channel TEXT NOT NULL, originating_group_id TEXT NOT NULL, originating_posting_id INTEGER NOT NULL REFERENCES postings(id),
      posting_side TEXT NOT NULL CHECK(posting_side IN ('FS','WTB')), brand TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
      reference TEXT NOT NULL DEFAULT '', dial TEXT NOT NULL DEFAULT '', condition TEXT NOT NULL DEFAULT '', price NUMERIC,
      presented_match_id INTEGER NOT NULL REFERENCES matches(id), presented_candidate_posting_id INTEGER NOT NULL REFERENCES postings(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '15 days',
      UNIQUE(canonical_user_id, originating_posting_id, presented_match_id));
      CREATE INDEX IF NOT EXISTS group_match_more_recent ON group_match_more_contexts(canonical_user_id,created_at DESC);`);
  });
}

export async function saveMoreContext(userId:number, channel:string, self:PostingRow, candidate:PostingRow, matchId:number):Promise<void>{
  if(self.source_type!=="chat"||!self.source_chat_id)return;
  await ready();
  await withSchema(pool=>pool.query(`INSERT INTO group_match_more_contexts
    (canonical_user_id,channel,originating_group_id,originating_posting_id,posting_side,brand,model,reference,dial,condition,price,presented_match_id,presented_candidate_posting_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,
    [userId,channel,self.source_chat_id,self.id,self.type,self.brand,self.model,self.reference,self.dial,self.condition,self.price,matchId,candidate.id]));
}

export async function getRecentMoreContext(userId:number):Promise<MoreContext|null>{
  await ready();
  return withSchema(async pool=>(await pool.query(`SELECT * FROM group_match_more_contexts WHERE canonical_user_id=$1 AND expires_at>now() ORDER BY created_at DESC,id DESC LIMIT 1`,[userId])).rows[0]??null);
}

function clean(v:unknown):string{return String(v??"").trim().toLowerCase()}
function label(p:any):string{return [p.brand,p.model,p.reference].filter(Boolean).join(" ")||p.original_text.slice(0,80)}
export async function formatMoreResults(userId:number):Promise<string>{
  const c=await getRecentMoreContext(userId); if(!c)return MORE_NO_CONTEXT;
  const wanted=c.posting_side==="WTB"?"FS":"WTB";
  const rows=await withSchema(async pool=>(await pool.query(`SELECT p.* FROM postings p
    WHERE p.type=$1 AND p.status='active' AND p.expires_at>now() AND p.id<>$2
      AND (p.canonical_user_id IS NULL OR p.canonical_user_id<>$3)
      AND ($4='' OR lower(p.reference)=lower($4) OR lower(p.brand)=lower($5) OR lower(p.model)=lower($6))
    ORDER BY CASE WHEN $4<>'' AND lower(p.reference)=lower($4) THEN 0 WHEN $5<>'' AND lower(p.brand)=lower($5) AND ($6='' OR lower(p.model)=lower($6)) THEN 1 ELSE 2 END,
      CASE WHEN $7<>'' AND lower(p.dial)=lower($7) THEN 0 ELSE 1 END,p.created_at DESC LIMIT 20`,
    [wanted,c.presented_candidate_posting_id,userId,c.reference,c.brand,c.model,c.dial])).rows);
  const unique:any[]=[]; const seen=new Set<string>();
  for(const p of rows){const key=[clean(p.external_listing_id),clean(p.reference),clean(p.price),clean(p.detail_url)].join('|');if(seen.has(key))continue;seen.add(key);unique.push(p);if(unique.length===5)break;}
  if(!unique.length)return c.posting_side==="WTB"?"I don’t see any additional WatchFacts listings that fit this request right now. I’ll keep monitoring.":"I don’t see any additional WatchFacts buyer opportunities that fit this request right now. I’ll keep monitoring.";
  const subject=[c.brand,c.model,c.reference].filter(Boolean).join(" ")||"your request";
  const heading=c.posting_side==="WTB"?`Here are ${unique.length} more WatchFacts listings for ${subject}:`:`Here are ${unique.length} more WatchFacts buyer opportunities for ${subject}:`;
  return heading+"\n\n"+unique.map((p,i)=>{const lines=[`${i+1}. ${label(p)}`];const details=[p.dial,p.year,p.box_papers,p.condition].filter(Boolean);if(details.length)lines.push(details.join(" • "));if(p.price!=null)lines.push(`${p.currency==='USD'?'$':p.currency+' '}${Number(p.price).toLocaleString('en-US')}`);if(p.location)lines.push(p.location);if(p.detail_url)lines.push(`Source: ${p.detail_url}`);const photo=p.image_url;if(photo)lines.push(`Photo: ${photo}`);return lines.join("\n")}).join("\n\n");
}
