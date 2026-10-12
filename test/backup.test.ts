import { test } from "node:test";
import assert from "node:assert/strict";
import { makeBackup, parseBackup, restoreMissing } from "../src/backup.ts";

test("backup roundtrip preserves note names and content", async () => {
  const notes = [{name:"inbox/a.md",content:"# A\nhello"},{name:"goals/b.md",content:"# B\nworld"}];
  const backup = parseBackup(JSON.parse(JSON.stringify(makeBackup(notes))));
  const restored = new Map<string,string>();
  assert.equal(await restoreMissing(backup,new Set(),async(n,c)=>{restored.set(n,c);}),2);
  assert.deepEqual([...restored],notes.map(n=>[n.name,n.content]));
});
test("restore refuses existing files without writing", async () => {
  const b=makeBackup([{name:"inbox/a.md",content:"# A"},{name:"inbox/b.md",content:"# B"}]);
  let writes=0;
  await assert.rejects(restoreMissing(b,new Set(["inbox/b.md"]),async()=>{writes++;}),/existing note/);
  assert.equal(writes,0);
});
test("reject malformed, duplicate, unsafe and oversized backups", () => {
  const good=makeBackup([{name:"inbox/a.md",content:"# A"}]);
  for(const bad of [
    {...good,version:2},
    {...good,notes:[{name:"../secret.md",content:"secret"}]},
    {...good,notes:[good.notes[0],good.notes[0]]},
    {...good,notes:[{name:"inbox/a.md",content:""}]},
    {...good,notes:[{name:"inbox/a.md",content:"x".repeat(1024*1024+1)}]}
  ]) assert.throws(()=>parseBackup(bad));
});
