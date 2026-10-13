/** Owner-scoped Awareness feedback and retention. Stores metadata, not private note text. */
export interface HistoryStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(keys: string | string[]): Promise<unknown>;
  list<T>(options: { prefix: string }): Promise<Map<string,T>>;
}
export type AwarenessOutcome = "opened"|"dismissed"|"snoozed"|"muted"|"sent"|"delivery-unconfirmed";
export interface FeedbackRecord {
  candidateId: string; outcome: AwarenessOutcome; at: string;
}
const validId = (id:string) => /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,159}$/.test(id);
const ownerPrefix = (owner:string) => { if(!validId(owner)) throw new Error("Invalid owner"); return "awareness:feedback:"+encodeURIComponent(owner)+":"; };
const RETAIN_MS=30*86_400_000;
const PREFIXES=["awareness:event:","awareness:inbox:","awareness:feedback:","awareness:delivery:","awareness:delivery-count:"];
const LOCAL_KEYS=["awareness:delivery:last:local"];
export class AwarenessHistory {
  constructor(private readonly storage:HistoryStorage) {}
  async record(owner:string, candidateId:string, outcome:AwarenessOutcome, now=new Date().toISOString()):Promise<FeedbackRecord> {
    if(!validId(candidateId) || !["opened","dismissed","snoozed","muted","sent","delivery-unconfirmed"].includes(outcome) || !Number.isFinite(Date.parse(now)))
      throw new Error("Invalid awareness feedback");
    const key=ownerPrefix(owner)+encodeURIComponent(candidateId)+":"+encodeURIComponent(outcome);
    const existing=await this.storage.get<FeedbackRecord>(key);
    if(existing) return existing;
    const record={candidateId,outcome,at:now};
    await this.storage.put(key,record);
    return record;
  }
  async list(owner:string,limit=100):Promise<FeedbackRecord[]> {
    if(!Number.isSafeInteger(limit)||limit<1||limit>500) throw new Error("Invalid history limit");
    return [...(await this.storage.list<FeedbackRecord>({prefix:ownerPrefix(owner)})).values()]
      .sort((a,b)=>b.at.localeCompare(a.at)).slice(0,limit);
  }
  /** Remove expired records and stale delivery reservations in bounded batches. */
  async prune(owner:string,now=new Date().toISOString()):Promise<number> {
    const cutoff=Date.parse(now)-RETAIN_MS;
    if(!Number.isFinite(cutoff)) throw new Error("Invalid prune date");
    const doomed:string[]=[];
    for(const type of ["awareness:feedback:","awareness:inbox:","awareness:event:","awareness:delivery:"]) {
      const entries=await this.storage.list<unknown>({prefix:type+encodeURIComponent(owner)+":"});
      for(const [key,value] of entries) {
        const v=value as Record<string,unknown>;
        const at=type.includes("inbox:") ? (v.candidate as Record<string,unknown>|undefined)?.expiresAt :
          type.includes("event:") ? v.occurredAt : type.includes("feedback:") ? v.at : (v.at ?? null);
        if(typeof at==="string" && Number.isFinite(Date.parse(at)) && Date.parse(at)<cutoff) doomed.push(key);
      }
    }
    for(let i=0;i<doomed.length;i+=128) await this.storage.delete(doomed.slice(i,i+128));
    return doomed.length;
  }
  /** Explicit owner-local erasure: events, inbox, feedback, delivery state and preferences. */
  async erase(owner:string):Promise<number> {
    if(owner!=="local") throw new Error("Unsupported owner");
    const keys:string[]=[];
    for(const prefix of PREFIXES) {
      const p=prefix+"local"+(prefix==="awareness:delivery-count:"?"":":");
      for(const key of (await this.storage.list<unknown>({prefix:p})).keys()) keys.push(key);
    }
    keys.push(...LOCAL_KEYS,"awareness:preferences:local");
    for(let i=0;i<keys.length;i+=128) await this.storage.delete(keys.slice(i,i+128));
    return keys.length;
  }
}
