/**
 * Evidence-grounded "Why this?" explanation.
 * This module never fetches arbitrary notes, sends data to a model, or guesses
 * missing evidence. Callers must provide an authorized, owner-scoped evidence set.
 */
export interface ExplanationCandidate {
  ownerId:string; ruleId:string; evidenceEventIds:string[]; reason:string;
}
export interface ExplanationEvidence {
  id:string; ownerId:string; source:string; observedAt:string;
  description:string; permitted:boolean;
}
export interface AwarenessExplanation {
  status:"available"|"unavailable";
  text:string;
  evidence:{id:string;source:string;observedAt:string}[];
}
const validId=(s:string)=>/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,159}$/.test(s);
const safe=(s:string)=>s.replace(/[<>\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim();
export function explainAwareness(candidate:ExplanationCandidate,evidence:readonly ExplanationEvidence[],
  options:{ownerId:string;enabled:boolean;maxAgeDays?:number;now?:number}):AwarenessExplanation {
  const unavailable=():AwarenessExplanation=>({status:"unavailable",text:"Supporting evidence is not available.",evidence:[]});
  if(!options.enabled||!validId(options.ownerId)||candidate.ownerId!==options.ownerId||
     !candidate.evidenceEventIds.length||candidate.evidenceEventIds.length>20)return unavailable();
  const ids=new Set(candidate.evidenceEventIds);
  if(ids.size!==candidate.evidenceEventIds.length)return unavailable();
  const byId=new Map<string,ExplanationEvidence>();
  for(const item of evidence){
    if(!validId(item.id)||!ids.has(item.id))continue;
    if(byId.has(item.id))return unavailable();
    byId.set(item.id,item);
  }
  const now=options.now??Date.now(),maxAge=(options.maxAgeDays??30)*86400000;
  if(!Number.isFinite(maxAge)||maxAge<=0||maxAge>90)return unavailable();
  const matched:ExplanationEvidence[]=[];
  for(const id of candidate.evidenceEventIds){
    const item=byId.get(id);
    if(!item||!item.permitted||item.ownerId!==options.ownerId||
       !Number.isFinite(Date.parse(item.observedAt))||
       Date.parse(item.observedAt)>now+60000||now-Date.parse(item.observedAt)>maxAge||
       !item.description||item.description.length>240)return unavailable();
    matched.push(item);
  }
  // Only trusted, supplied evidence is shown. The candidate's ungrounded
  // reason is intentionally not repeated as if it were evidence.
  return {status:"available",
    text:"Why this? "+matched.map(item=>safe(item.description)).join("; ").slice(0,600),
    evidence:matched.map(item=>({id:item.id,source:safe(item.source).slice(0,60),observedAt:item.observedAt}))};
}
