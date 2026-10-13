import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

// Browser-level contract test of the actual Awareness UI functions, with a private
// in-memory API stub. No Cloudflare credentials, external services, or pushes.
const html=readFileSync(new URL("../../src/app.html",import.meta.url),"utf8");
const start=html.indexOf("async function renderAwarenessPreferences()");
const end=html.indexOf("/* ---------- Router ---------- */",start);
if(start<0||end<0) throw new Error("Awareness UI entrypoint missing");
const awareness=html.slice(start,end);
const fixture=`<main id="main"></main><script>
const main=document.getElementById("main");
const $=selector=>document.querySelector(selector);
const toast=message=>{document.body.dataset.toast=message};
let prefs={enabled:false,paused:false,mode:"inbox",sources:{daybook:true,appleReminders:false,calendar:false,github:false},quietHours:{start:"22:00",end:"08:00"},dailyPushBudget:2};
let items=[];
let error=false;
const api=async (path,opts={})=>{
 if(error && path.startsWith("/awareness/inbox")) throw Error("Offline");
 if(path.startsWith("/awareness/inbox")) return {items:items.filter(x=>x.state==="active"),nextCursor:null};
 if(path==="/awareness/preferences") {
   if(opts.method==="PUT"){prefs=opts.body;return prefs}
   return prefs;
 }
 if(path==="/awareness/action") {
   const entry=items.find(x=>x.candidate.id===opts.body.id);
   if(entry)entry.state=opts.body.action;
   return entry;
 }
 throw Error("Unexpected API call "+path);
};
${awareness}
</script>`;
test.beforeEach(async({page})=>{
 await page.setContent(fixture);
});
test("mobile inbox loads without requesting notification permission",async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.evaluate(()=>{(window as any).Notification={requestPermission:()=>{throw Error("permission requested")}};});
 await page.evaluate(()=> (window as any).renderAwareness());
 await expect(page.getByText("You're all caught up.")).toBeVisible();
 await expect(page.getByText("Awareness settings")).toBeVisible();
 await expect(page.getByText("Off by default.",{exact:false})).toBeVisible();
});
test("preferences save opt-in and quiet hours on mobile",async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.evaluate(()=> (window as any).renderAwareness());
 await page.getByLabel("Enable Awareness").check();
 await page.getByLabel("Awareness mode").selectOption("proactive");
 await page.getByLabel("Quiet hours start").fill("21:30");
 await page.getByRole("button",{name:"Save Awareness settings"}).click();
 await expect(page.getByText("Awareness settings saved")).toBeVisible({timeout:5000}).catch(async()=>{
   expect(await page.evaluate(()=>document.body.dataset.toast)).toBe("Awareness settings saved");
 });
 const prefs=await page.evaluate(()=>(window as any).prefs);
 expect(prefs.enabled).toBe(true);expect(prefs.mode).toBe("proactive");
 expect(prefs.quietHours.start).toBe("21:30");
});
test("inbox renders evidence safely and dismisses a suggestion",async({page})=>{
 await page.evaluate(()=>{
   (window as any).items=[{state:"active",candidate:{id:"candidate1",reason:"<img src=x onerror=alert(1)>",evidenceEventIds:["event1"]}}];
   return (window as any).renderAwareness();
 });
 await expect(page.getByText("<img src=x onerror=alert(1)>")).toBeVisible();
 expect(await page.locator(".awareness-card img").count()).toBe(0);
 await page.getByRole("button",{name:"Dismiss"}).click();
 await expect(page.getByText("No active suggestions right now.")).toBeVisible();
});
test("API errors remain visible without crashing the mobile view",async({page})=>{
 await page.evaluate(()=>{(window as any).error=true;return (window as any).renderAwareness()});
 await expect(page.getByText("Could not load Awareness: Offline")).toBeVisible();
 await expect(page.getByText("Awareness settings")).toBeVisible();
});
