/** Strict, privacy-minimizing GitHub webhook intake primitives. */
export interface GitHubSignal {
  id:string; source:"github"; kind:"ci"|"pull-request";
  repository:string; subject:string; state:string; occurredAt:string;
}
export type GitHubConsent={enabled:boolean;paused:boolean;github:boolean;connected:boolean};
const MAX_BODY=128*1024;
const deliveryPattern=/^[a-zA-Z0-9-]{8,100}$/;
function hex(bytes:ArrayBuffer):string {
  return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,"0")).join("");
}
export async function verifyGitHubWebhook(body:Uint8Array,signature:string|null,secret:string):Promise<boolean> {
  if(!secret||body.byteLength===0||body.byteLength>MAX_BODY||!signature||!/^sha256=[a-f0-9]{64}$/.test(signature))return false;
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const expected="sha256="+hex(await crypto.subtle.sign("HMAC",key,body));
  const a=new TextEncoder().encode(expected),b=new TextEncoder().encode(signature);
  let diff=0;
  for(let i=0;i<a.length;i++)diff|=a[i]^b[i];
  return diff===0;
}
export function normalizeGitHubWebhook(event:string|null,delivery:string|null,payload:unknown,consent:GitHubConsent):GitHubSignal|null {
  if(!consent.enabled||consent.paused||!consent.github||!consent.connected)return null;
  if(!delivery||!deliveryPattern.test(delivery)||!payload||typeof payload!=="object")return null;
  const p=payload as Record<string,unknown>;
  const repo=p.repository as Record<string,unknown>|undefined;
  if(!repo||typeof repo.full_name!=="string"||!/^[\w.-]+\/[\w.-]+$/.test(repo.full_name))return null;
  if(event==="workflow_run"){
    const run=p.workflow_run as Record<string,unknown>|undefined;
    if(!run||!Number.isSafeInteger(run.id)||!["completed"].includes(String(p.action))||
      !["success","failure","cancelled"].includes(String(run.conclusion)))return null;
    return {id:delivery,source:"github",kind:"ci",repository:repo.full_name,subject:String(run.id),
      state:String(run.conclusion),occurredAt:new Date().toISOString()};
  }
  if(event==="pull_request"){
    const pr=p.pull_request as Record<string,unknown>|undefined;
    if(!pr||!Number.isSafeInteger(pr.number)||!["opened","closed","reopened"].includes(String(p.action)))return null;
    return {id:delivery,source:"github",kind:"pull-request",repository:repo.full_name,
      subject:String(pr.number),state:String(p.action),occurredAt:new Date().toISOString()};
  }
  return null;
}
/** Replay barrier must be backed by owner-local Durable Object storage. */
export interface ReplayStorage {
  get<T>(key:string):Promise<T|undefined>;
  put<T>(key:string,value:T):Promise<void>;
}
export async function acceptGitHubDelivery(store:ReplayStorage,owner:string,signal:GitHubSignal):Promise<boolean> {
  if(!/^[\w.-]{1,100}$/.test(owner))throw Error("Invalid owner");
  const key="awareness:github-delivery:"+encodeURIComponent(owner)+":"+signal.id;
  if(await store.get(key))return false;
  await store.put(key,{at:signal.occurredAt});
  return true;
}
