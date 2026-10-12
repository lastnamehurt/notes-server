import { withLogType } from "./log-types";

export interface TimeSession { type:string; start:string; end:string; minutes:number; note:string; }
const SESSION = /\s@session:([^\s]+)\/([^\s]+)\s*$/;
export function timedEntry(entry:string,type:string,start:string,end:string):string {
  const a=Date.parse(start), b=Date.parse(end);
  if (!Number.isFinite(a)||!Number.isFinite(b)||b<=a||b-a>24*3600000) throw new Error("Session must have valid start/end times and last no more than 24 hours");
  if (!/^(?:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)$/.test(new Date(a).toISOString())) throw new Error("Invalid start");
  return withLogType(entry,type)+" @session:"+new Date(a).toISOString()+"/"+new Date(b).toISOString();
}
export function readSessions(notes:{name:string;content:string}[]):TimeSession[] {
  const out:TimeSession[]=[];
  for(const n of notes.filter(n=>/^journal\/log\/\d{4}-\d\d-\d\d\.md$/.test(n.name))) {
    for(const line of n.content.split("\n")) {
      const match=SESSION.exec(line);
      if(!match)continue;
      const start=Date.parse(match[1]),end=Date.parse(match[2]);
      if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>86400000)continue;
      const text=line.replace(SESSION,"");
      const tag=/(?:^|\s)#([a-z][a-z0-9-]*)\b/.exec(text);
      if(!tag)continue;
      out.push({type:tag[1],start:new Date(start).toISOString(),end:new Date(end).toISOString(),minutes:(end-start)/60000,note:text.replace(/^- \d\d:\d\d /,"").trim()});
    }
  }
  return out;
}
export function timeSummary(sessions:TimeSession[],from:string,to:string) {
  const fromMs=Date.parse(from),toMs=Date.parse(to);
  if(!Number.isFinite(fromMs)||!Number.isFinite(toMs)||toMs<=fromMs||toMs-fromMs>366*86400000)throw new Error("Invalid summary range (maximum 366 days)");
  const totals=new Map<string,number>();
  const intervals:[number,number][]=[];
  for(const s of sessions) {
    const a=Math.max(Date.parse(s.start),fromMs),b=Math.min(Date.parse(s.end),toMs);
    if(b<=a)continue;
    totals.set(s.type,(totals.get(s.type)||0)+(b-a)/60000);
    intervals.push([a,b]);
  }
  intervals.sort((a,b)=>a[0]-b[0]);
  let covered=0,begin=0,end=0;
  for(const [a,b] of intervals) {
    if(a>end){covered+=end-begin;begin=a;end=b;}else end=Math.max(end,b);
  }
  covered+=end-begin;
  return {byType:[...totals].sort((a,b)=>b[1]-a[1]).map(([type,minutes])=>({type,minutes})),trackedMinutes:covered/60000,sessionCount:intervals.length};
}
