import test from "node:test";
import assert from "node:assert/strict";
import {verifyGitHubWebhook,normalizeGitHubWebhook,acceptGitHubDelivery} from "../src/awareness-github-webhook";
const consent={enabled:true,paused:false,github:true,connected:true};
const payload={action:"completed",repository:{full_name:"org/repo"},workflow_run:{id:42,conclusion:"failure",name:"private build",head_commit:{message:"secret"}}};
const delivery="12345678-1234-1234-1234-123456789abc";
test("valid SHA256 signature accepted; tampering and oversize rejected",async()=>{
 const body=new TextEncoder().encode(JSON.stringify(payload));
 const key=await crypto.subtle.importKey("raw",new TextEncoder().encode("secret"),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const sig="sha256="+[...new Uint8Array(await crypto.subtle.sign("HMAC",key,body))].map(b=>b.toString(16).padStart(2,"0")).join("");
 assert.equal(await verifyGitHubWebhook(body,sig,"secret"),true);
 assert.equal(await verifyGitHubWebhook(new TextEncoder().encode("tampered"),sig,"secret"),false);
 assert.equal(await verifyGitHubWebhook(body,null,"secret"),false);
 assert.equal(await verifyGitHubWebhook(new Uint8Array(131073),sig,"secret"),false);
});
test("CI and PR events normalize without private payload fields",()=>{
 const ci=normalizeGitHubWebhook("workflow_run",delivery,payload,consent);
 assert.equal(ci?.state,"failure");assert.equal(ci?.subject,"42");
 assert.ok(!JSON.stringify(ci).includes("private"));
 assert.ok(!JSON.stringify(ci).includes("secret"));
 const pr=normalizeGitHubWebhook("pull_request",delivery,{action:"opened",repository:{full_name:"org/repo"},pull_request:{number:17,title:"private"}},consent);
 assert.equal(pr?.kind,"pull-request");assert.equal(pr?.subject,"17");
});
test("opt-out, unsupported events and malformed delivery are ignored",()=>{
 assert.equal(normalizeGitHubWebhook("workflow_run",delivery,payload,{...consent,github:false}),null);
 assert.equal(normalizeGitHubWebhook("push",delivery,payload,consent),null);
 assert.equal(normalizeGitHubWebhook("workflow_run","bad",payload,consent),null);
});
test("owner-scoped replay protection refuses duplicate deliveries",async()=>{
 const data=new Map<string,unknown>();
 const store={get:async<T>(k:string)=>data.get(k) as T|undefined,put:async<T>(k:string,v:T)=>{data.set(k,v)}};
 const signal=normalizeGitHubWebhook("workflow_run",delivery,payload,consent)!;
 assert.equal(await acceptGitHubDelivery(store,"local",signal),true);
 assert.equal(await acceptGitHubDelivery(store,"local",signal),false);
 assert.equal(await acceptGitHubDelivery(store,"other",signal),true);
});
