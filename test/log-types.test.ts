import {test} from "node:test";
import {strict as assert} from "node:assert";
import {normalizeLogType,withLogType,parseLogTypes} from "../src/log-types";
test("custom log type normalization",()=>{
 assert.equal(normalizeLogType("Cardio Log"),"cardio-log");
 assert.throws(()=>normalizeLogType("!!!"));
});
test("typed entries use journal tags without duplicates",()=>{
 assert.equal(withLogType("Walked 25 minutes","Cardio"),"Walked 25 minutes #cardio");
 assert.equal(withLogType("Walked #cardio","cardio"),"Walked #cardio");
});
test("existing journal tags become discoverable log types",()=>{
 const types=parseLogTypes([{name:"journal/log/2026-10-11.md",content:"# Log\n- 09:00 Walked #cardio\n- 10:00 Ate lunch #food\n- 11:00 Ran #cardio"},{name:"journal/types/sleep.md",content:"# sleep"}]);
 assert.deepEqual(types,[{name:"cardio",count:2},{name:"food",count:1},{name:"sleep",count:0}]);
});
