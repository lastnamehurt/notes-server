/** Opt-in Awareness preferences. Never store notification tokens or note content here. */
export interface AwarenessPreferences {
  enabled: boolean;
  paused: boolean;
  mode: "inbox" | "digest" | "proactive";
  sources: { daybook: boolean; appleReminders: boolean; calendar: boolean; github: boolean };
  quietHours: { start: string; end: string };
  dailyPushBudget: number;
}
export const DEFAULT_AWARENESS_PREFERENCES: AwarenessPreferences = {
  enabled: false, paused: false, mode: "inbox",
  sources: { daybook: true, appleReminders: false, calendar: false, github: false },
  quietHours: { start: "22:00", end: "08:00" }, dailyPushBudget: 2
};
const time = (value: unknown) => typeof value === "string" && /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);
export function parseAwarenessPreferences(input: unknown): AwarenessPreferences {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid Awareness preferences");
  const x = input as Record<string, unknown>;
  if (Object.keys(x).some(k => !["enabled","paused","mode","sources","quietHours","dailyPushBudget"].includes(k)) ||
      typeof x.enabled !== "boolean" || typeof x.paused !== "boolean" ||
      !["inbox","digest","proactive"].includes(String(x.mode)) ||
      !Number.isInteger(x.dailyPushBudget) || (x.dailyPushBudget as number) < 0 || (x.dailyPushBudget as number) > 2)
    throw new Error("Invalid Awareness preferences");
  const sources = x.sources as Record<string,unknown> | null;
  const quiet = x.quietHours as Record<string,unknown> | null;
  if (!sources || typeof sources !== "object" || Array.isArray(sources) ||
      Object.keys(sources).sort().join(",") !== "appleReminders,calendar,daybook,github" ||
      Object.values(sources).some(v => typeof v !== "boolean") ||
      !quiet || typeof quiet !== "object" || Array.isArray(quiet) ||
      Object.keys(quiet).sort().join(",") !== "end,start" || !time(quiet.start) || !time(quiet.end) ||
      quiet.start === quiet.end) throw new Error("Invalid Awareness preferences");
  return { enabled: x.enabled as boolean, paused: x.paused as boolean,
    mode: x.mode as AwarenessPreferences["mode"], sources: sources as unknown as AwarenessPreferences["sources"],
    quietHours: quiet as AwarenessPreferences["quietHours"], dailyPushBudget: x.dailyPushBudget as number };
}
