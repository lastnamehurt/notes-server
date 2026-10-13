import test from "node:test";
import assert from "node:assert/strict";
import { AwarenessHistory } from "../src/awareness-history";
class Memory {
 data=new Map<string,unknown>();
 async get<T>(k:string){return this.data.get(k) as T|undefined;}
 async put<T>(k:string,v:T){this.data.set(k,v);}
 async delete(keys:string|string[]){for(const k of typeof keys==="string"?[keys]:keys)this.data.delete(k);}
 async list<T>({prefix}:{prefix:string}){return new Map([...this.data].filter(([k])=>k.startsWith(prefix))) as Map<string,T>;}
}
test("feedback is owner scoped and idempotent without note content",async()=>{
 const db=new Memory(),h=new AwarenessHistory(db);
 const a=await h.record("local","candidate1","dismissed","2026-10-13T00:00:00Z");
 const b=await h.record("local","candidate1","dismissed","2026-10-14T00:00:00Z");
 assert.deepEqual(a,b);assert.equal((await h.list("local")).length,1);
 assert.equal((await h.list("other")).length,0);
 assert.ok(!JSON.stringify([...db.data]).includes("note content"));
});
test("prune removes old feedback and events, preserves recent records",async()=>{
 const db=new Memory(),h=new AwarenessHistory(db);
 await h.record("local","old","dismissed","2026-08-01T00:00:00Z");
 await h.record("local","new","opened","2026-10-10T00:00:00Z");
 await db.put("awareness:event:local:old",{occurredAt:"2026-08-01T00:00:00Z"});
 await db.put("awareness:inbox:local:old",{candidate:{expiresAt:"2026-08-01T00:00:00Z"}});
 assert.equal(await h.prune("local","2026-10-13T00:00:00Z"),3);
 assert.equal((await h.list("local")).length,1);
});
test("erasure deletes local awareness state but not reminders or other owners",async()=>{
 const db=new Memory(),h=new AwarenessHistory(db);
 for(const k of ["awareness:event:local:a","awareness:inbox:local:b","awareness:feedback:local:c","awareness:delivery:local:d","awareness:delivery-count:local:2026-10-13","awareness:delivery:last:local","awareness:preferences:local","r:task","awareness:event:other:a"]) await db.put(k,{at:"2026-10-13T00:00:00Z"});
 await h.erase("local");
 assert.deepEqual([...db.data.keys()].sort(),["awareness:event:other:a","r:task"]);
});
test("invalid owner, outcomes and limits fail closed",async()=>{
 const h=new AwarenessHistory(new Memory());
 await assert.rejects(h.record("bad owner","a","sent"));
 await assert.rejects(h.record("local","a","bad" as never));
 await assert.rejects(h.list("local",501));
 await assert.rejects(h.erase("other"));
});
