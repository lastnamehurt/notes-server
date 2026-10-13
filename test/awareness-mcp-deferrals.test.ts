import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {taskDeferrals} from "../src/awareness-deferrals";
const source=readFileSync(new URL("../src/index.ts",import.meta.url),"utf8");
test("MCP update_note captures after a successful commit only",()=>{
 const start=source.indexOf('server.registerTool("update_note"');
 const end=source.indexOf('server.registerTool("delete_note"',start);
 const handler=source.slice(start,end);
 assert.ok(handler.indexOf("await notes.get(name)") < handler.indexOf("await notes.update(name"));
 assert.ok(handler.indexOf("await notes.update(name") < handler.indexOf("recordTaskDeferrals"));
 assert.match(handler,/if \(changes\.length\)/);
 assert.match(handler,/catch \(e\)/);
});
test("MCP transition diff ignores priority edits and replayed unchanged due dates",()=>{
 const before="- [ ] Renew @2026-10-14 9am ^abcd";
 const later="- [ ] Renew @2026-10-16 9am ^abcd";
 assert.equal(taskDeferrals(before,later,"America/Los_Angeles").length,1);
 assert.deepEqual(taskDeferrals(later,later,"America/Los_Angeles"),[]);
 assert.deepEqual(taskDeferrals(before,"- [ ] Renew !high @2026-10-14 9am ^abcd","America/Los_Angeles"),[]);
});
