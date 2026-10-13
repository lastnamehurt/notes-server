/** Deterministic, owner-isolated Awareness relevance tuning. Never grants delivery permission. */
export type FeedbackAction = "opened"|"dismissed"|"snoozed"|"muted";
export interface RelevanceFeedback {
  ownerId:string; ruleId:string; action:FeedbackAction; at:string;
}
export interface RelevanceCandidate {
  ownerId:string; ruleId:string; id:string; urgency:string; createdAt:string;
}
export interface RelevanceDecision {
  score:number; evidenceCount:number; mode:"feedback"|"fallback";
}
/**
 * Score only within a caller-authorized candidate set. A score must never be
 * interpreted as consent, a push entitlement, or an interruption-policy override.
 */
export function scoreRelevance(candidate:RelevanceCandidate,feedback:readonly RelevanceFeedback[],
  context:{ownerId:string;enabled:boolean;now?:number}):RelevanceDecision {
  const fallback:RelevanceDecision={score:0,evidenceCount:0,mode:"fallback"};
  if(!context.enabled||!context.ownerId||candidate.ownerId!==context.ownerId)return fallback;
  const now=context.now??Date.now();
  if(!Number.isFinite(now))return fallback;
  const relevant=feedback.filter(item=>item.ownerId===context.ownerId&&item.ruleId===candidate.ruleId&&
    ["opened","dismissed","snoozed","muted"].includes(item.action)&&
    Number.isFinite(Date.parse(item.at))&&Date.parse(item.at)<=now&&now-Date.parse(item.at)<=30*86400000)
    .slice(-50);
  if(relevant.length<3)return fallback;
  // Deliberately bounded influence. Muting is negative relevance, not a
  // replacement for source-level or subject-level mute enforcement.
  const weights:Record<FeedbackAction,number>={opened:2,dismissed:-2,snoozed:-1,muted:-3};
  const total=relevant.reduce((sum,item)=>sum+weights[item.action],0);
  return {score:Math.max(-10,Math.min(10,total)),evidenceCount:relevant.length,mode:"feedback"};
}
export function rankAwareness<T extends RelevanceCandidate>(
  candidates:readonly T[],feedback:readonly RelevanceFeedback[],
  context:{ownerId:string;enabled:boolean;now?:number}):T[] {
  // The caller must first apply source consent, candidate authorization and
  // interruption policy. Here we refuse to include cross-owner candidates.
  return candidates.filter(c=>c.ownerId===context.ownerId)
    .map((candidate,index)=>({candidate,index,score:scoreRelevance(candidate,feedback,context).score}))
    .sort((a,b)=>b.score-a.score||a.index-b.index).map(item=>item.candidate);
}
