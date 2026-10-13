import { test } from "node:test";
import { strict as assert } from "node:assert";
import { calendarTasks, editCalendarTask, noteRevision, validDay } from "../src/calendar";
import { parseReminders, localStamp } from "../src/reminder-parse";
const zone = "America/Los_Angeles";

test("calendar keeps overdue dates, separates undated tasks, ignores completed tasks and uses reminder defaults", async () => {
  const tasks = await calendarTasks([{name:"inbox/a.md",content:"- [ ] Old @2026-09-01 @priority:do\n- [ ] New @2026-10-15\n- [ ] Undated\n- [x] Done @2026-10-15"}],"2026-10-01","2026-11-01",zone);
  assert.equal(tasks.length,3);
  assert.equal(tasks[0].title,"Old");
  assert.equal(localStamp(tasks[0].occurrences[0].at,zone).date,"2026-09-01");
  assert.equal(localStamp(tasks[1].occurrences[0].at,zone).time,"09:00");
  assert.equal(tasks[2].occurrences.length,0);
  assert.equal(tasks[0].priority,"do");
});
test("repeats expand across DST in the owner's timezone and exclude the end date",async()=>{
  const [t] = await calendarTasks([{name:"a",content:"- [ ] Meds @daily 8am, 8pm"}],"2026-10-31","2026-11-03",zone);
  assert.equal(t.occurrences.length,6);
  assert.equal(t.repeating,true);
  assert.deepEqual(t.occurrences.map(r=>localStamp(r.at,zone).time),["08:00","20:00","08:00","20:00","08:00","20:00"]);
  assert.equal(t.occurrences[2].at-t.occurrences[0].at,25*3600000);
});
test("duplicate titles remain separate tasks with their own lines",async()=>{
  const tasks=await calendarTasks([{name:"a",content:"- [ ] Call @2026-10-01\n- [ ] Call @2026-10-02"}],"2026-10-01","2026-11-01",zone);
  assert.deepEqual(tasks.map(t=>t.line),[0,1]);
  assert.notEqual(tasks[0].occurrences[0].at,tasks[1].occurrences[0].at);
});
test("invalid dates do not roll into another month; bounded ranges",async()=>{
  assert.equal(validDay("2026-02-30"),false);
  assert.equal(parseReminders("a","- [ ] Task @2026-02-30",zone).length,0);
  await assert.rejects(calendarTasks([],"2026-01-01","2026-05-01",zone));
  await assert.rejects(calendarTasks([],"2026-02-30","2026-03-01",zone));
});
test("edits preserve title, ID, other lines and priority while changing or clearing schedules",()=>{
  const before="# Tasks\n- [ ] Pay bill @daily 9am @priority:do ^abc123\n- [ ] Read";
  const changed=editCalendarTask(before,1,{schedule:"2026-10-20 14:30",priority:"plan"},zone);
  assert.equal(changed,"# Tasks\n- [ ] Pay bill @2026-10-20 14:30 @priority:plan ^abc123\n- [ ] Read");
  assert.equal(editCalendarTask(changed,1,{schedule:""},zone),"# Tasks\n- [ ] Pay bill @priority:plan ^abc123\n- [ ] Read");
  assert.match(editCalendarTask(changed,1,{done:true},zone),/\[x\] Pay bill/);
  assert.throws(()=>editCalendarTask(before,1,{schedule:"2026-02-30"},zone));
  assert.throws(()=>editCalendarTask(before,1,{schedule:"daily 9am\n- [ ] injected"},zone));
  assert.throws(()=>editCalendarTask(before,10,{done:true},zone));
});
test("snapshot revision detects edits elsewhere in the source note",async()=>{
  assert.notEqual(await noteRevision("- [ ] One"),await noteRevision("- [ ] Two\n- [ ] One"));
});
