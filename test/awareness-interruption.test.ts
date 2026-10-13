import test from "node:test";
import assert from "node:assert/strict";
import { interruptionDecision, localDayAndMinute } from "../src/awareness-interruption";
const settings = { enabled:true,paused:false,mode:"proactive" as const,quietHours:{start:"22:00",end:"08:00"},dailyPushBudget:2 };
const now = new Date("2026-10-13T19:00:00Z"); // 12:00 Pacific
const ctx = {now,timeZone:"America/Los_Angeles",candidateCreatedAt:"2026-10-13T18:00:00Z",candidateExpiresAt:"2026-10-20T18:00:00Z",candidateDedupeKey:"task:abc",sentToday:0,dismissed:false,muted:false,stale:false,alreadyDelivered:false};
const decide = (s: Partial<typeof settings> = {}, c: Partial<typeof ctx> = {}) => interruptionDecision({...settings,...s},{...ctx,...c});
test("eligible candidate may send during local daytime",()=>assert.equal(decide().action,"send"));
test("disabled, paused, inbox-only and stale suppress",()=>{
  for(const [s,c] of [[{enabled:false},{}],[{paused:true},{}],[{mode:"inbox" as const},{}],[{}, {stale:true}],[{}, {dismissed:true}],[{}, {muted:true}],[{}, {alreadyDelivered:true}]]) assert.equal(decide(s,c).action,"suppress");
});
test("digest mode, daily cap and cooldown do not send",()=>{
  assert.equal(decide({mode:"digest"}).action,"digest");
  assert.equal(decide({}, {sentToday:2}).reason,"daily-cap");
  assert.equal(decide({}, {lastSentAt:"2026-10-13T18:00:00Z"}).reason,"cooldown");
});
test("quiet hours cross midnight in local time and observe DST transitions",()=>{
  assert.equal(decide({}, {now:new Date("2026-10-13T06:00:00Z")}).reason,"quiet-hours");
  assert.equal(decide({}, {now:new Date("2026-10-13T14:00:00Z")}).reason,"quiet-hours");
  assert.equal(localDayAndMinute(new Date("2026-11-01T08:30:00Z"),"America/Los_Angeles").minute,90);
  assert.equal(localDayAndMinute(new Date("2026-11-01T09:30:00Z"),"America/Los_Angeles").minute,90);
  assert.equal(decide({}, {now:new Date("2026-11-01T09:30:00Z")}).reason,"quiet-hours");
});
test("expired, future-dated and invalid candidate data suppress",()=>{
  assert.equal(decide({}, {candidateExpiresAt:"2026-10-13T18:00:00Z"}).action,"suppress");
  assert.equal(decide({}, {candidateCreatedAt:"2026-10-14T18:00:00Z"}).action,"suppress");
  assert.equal(decide({}, {candidateDedupeKey:""}).action,"suppress");
});
test("daily budget zero falls back to digest",()=>assert.equal(decide({dailyPushBudget:0}).action,"digest"));
