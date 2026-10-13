/** Pure, fail-closed Awareness interruption policy. Does not send notifications. */
export interface InterruptionSettings {
  enabled: boolean; paused: boolean; mode: "inbox" | "digest" | "proactive";
  quietHours: { start: string; end: string }; dailyPushBudget: number;
}
export type InterruptionDecision = { action: "send" | "digest" | "suppress"; reason: string };
export interface InterruptionContext {
  now: Date; timeZone: string; candidateCreatedAt: string; candidateExpiresAt: string;
  candidateDedupeKey: string; lastSentAt?: string; sentToday: number;
  dismissed: boolean; muted: boolean; stale: boolean; alreadyDelivered: boolean;
}
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const parseMinutes = (value: string) => {
  if (!/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value)) throw new Error("Invalid quiet hours");
  const [h,m] = value.split(":").map(Number); return h*60+m;
};
export function localDayAndMinute(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US",{timeZone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(now);
  const p = Object.fromEntries(parts.map(part=>[part.type,part.value]));
  return { day: p.year+"-"+p.month+"-"+p.day, minute: Number(p.hour)*60+Number(p.minute) };
}
export function interruptionDecision(settings: InterruptionSettings, ctx: InterruptionContext): InterruptionDecision {
  const now = ctx.now.getTime(), created = Date.parse(ctx.candidateCreatedAt), expires = Date.parse(ctx.candidateExpiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(created) || !Number.isFinite(expires) ||
      expires <= created || created > now + 5*MINUTE || expires <= now || !ctx.candidateDedupeKey)
    return {action:"suppress",reason:"invalid-or-expired"};
  if (ctx.dismissed || ctx.muted) return {action:"suppress",reason:"dismissed-or-muted"};
  if (ctx.stale) return {action:"suppress",reason:"stale"};
  if (ctx.alreadyDelivered) return {action:"suppress",reason:"already-delivered"};
  if (!settings.enabled || settings.paused) return {action:"suppress",reason:"disabled-or-paused"};
  if (settings.mode === "inbox") return {action:"suppress",reason:"inbox-only"};
  if (settings.mode === "digest") return {action:"digest",reason:"digest-mode"};
  if (settings.mode !== "proactive") return {action:"suppress",reason:"unknown-mode"};
  if (!Number.isSafeInteger(settings.dailyPushBudget) || settings.dailyPushBudget < 0 || settings.dailyPushBudget > 2 ||
      !Number.isSafeInteger(ctx.sentToday) || ctx.sentToday < 0) return {action:"suppress",reason:"invalid-budget"};
  const start = parseMinutes(settings.quietHours.start), end = parseMinutes(settings.quietHours.end);
  const local = localDayAndMinute(ctx.now,ctx.timeZone);
  const quiet = start < end ? local.minute >= start && local.minute < end
    : start > end ? local.minute >= start || local.minute < end : true;
  if (quiet) return {action:"digest",reason:"quiet-hours"};
  if (ctx.sentToday >= settings.dailyPushBudget) return {action:"digest",reason:"daily-cap"};
  if (ctx.lastSentAt) {
    const last = Date.parse(ctx.lastSentAt);
    if (!Number.isFinite(last) || last > now) return {action:"suppress",reason:"invalid-last-send"};
    if (now-last < 4*HOUR) return {action:"digest",reason:"cooldown"};
  }
  return {action:"send",reason:"eligible"};
}
