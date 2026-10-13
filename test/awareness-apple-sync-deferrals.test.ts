import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {taskDeferrals} from "../src/awareness-deferrals";
const run=readFileSync(new URL("../src/apple-sync-run.ts",import.meta.url),"utf8");
const web=readFileSync(new URL("../src/web.ts",import.meta.url),"utf8");
test("Apple sync captures only after successful commit, not during conflict retry",()=>{
 const commit=run.indexOf("await o.notes.commitFiles(head, changed");
 const catchConflict=run.indexOf("if (e instanceof Error && e.message.startsWith");
 const capture=run.indexOf("await o.deferralsCommitted(events)");
 assert.ok(commit>=0&&catchConflict>commit&&capture>catchConflict);
 assert.match(run,/if \(o\.deferralsCommitted && changed\.size\)/);
 assert.match(run,/catch \(e\) \{[\s\S]*?Apple sync Awareness capture failed/);
 assert.match(web,/deferralsCommitted: events => scheduler\(configured\)\.recordTaskDeferrals\(events, "appleReminders"\)/);
});
test("only postponed ID-bearing tasks count, not sync echo or other edits",()=>{
 const old="- [ ] Submit @2026-10-14 9am ^abcd";
 const later="- [ ] Submit @2026-10-16 9am ^abcd";
 const zone="America/Los_Angeles";
 assert.equal(taskDeferrals(old,later,zone).length,1);
 assert.deepEqual(taskDeferrals(later,later,zone),[]);
 assert.deepEqual(taskDeferrals(old,"- [ ] Submit !high @2026-10-14 9am ^abcd",zone),[]);
 assert.deepEqual(taskDeferrals(old,"- [ ] Submit @2026-10-13 9am ^abcd",zone),[]);
 assert.deepEqual(taskDeferrals("- [ ] Submit @2026-10-14 9am", "- [ ] Submit @2026-10-16 9am",zone),[]);
});
