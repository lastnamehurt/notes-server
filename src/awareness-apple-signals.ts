/** Pure consent-gated Apple sync signal normalization; never sends notifications. */
export type AppleSnapshot = { id:string; dueAt:string|null; completed:boolean };
export type AppleConsent = { enabled:boolean; paused:boolean; appleReminders:boolean; connected:boolean };
export type AppleSignal = { id:string; taskId:string; type:"task.deferred"|"task.completed"|"task.updated"; fromDueAt?:string; toDueAt?:string };
export function appleSignals(before:readonly AppleSnapshot[],after:readonly AppleSnapshot[],runId:string,consent:AppleConsent):AppleSignal[] {
  if(!consent.enabled||consent.paused||!consent.appleReminders||!consent.connected)return [];
  if(!/^[a-zA-Z0-9_-]{8,100}$/.test(runId))throw Error("Invalid sync run");
  const previous=new Map<string,AppleSnapshot>();
  const duplicate=new Set<string>();
  for(const item of before){if(previous.has(item.id))duplicate.add(item.id);previous.set(item.id,item);}
  const seen=new Set<string>(),out:AppleSignal[]=[];
  for(const item of after){
    if(!/^[a-z0-9]{4,12}$/.test(item.id)||seen.has(item.id)||duplicate.has(item.id))continue;
    seen.add(item.id);
    const old=previous.get(item.id);
    if(!old)continue;
    const from=old.dueAt,to=item.dueAt;
    const completed=!old.completed&&item.completed;
    const moved=!item.completed&&from!==to;
    const deferred=moved&&from!==null&&to!==null&&Number.isFinite(Date.parse(from))&&Number.isFinite(Date.parse(to))&&Date.parse(to)>Date.parse(from);
    const type=completed?"task.completed":deferred?"task.deferred":moved?"task.updated":null;
    if(!type)continue;
    const id="apple-"+runId+"-"+item.id+"-"+type.replace(".","-");
    if(id.length>160)continue;
    out.push({id,taskId:item.id,type,...(deferred?{fromDueAt:from!,toDueAt:to!}:{})});
  }
  return out;
}
