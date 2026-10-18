// Lock screen glance (#widget): a tiny, read-only summary for a Scriptable widget on the iPhone.
// Spending for today and this week, and two things from notes: the inbox count and the last log line.
// Tasks are left out on purpose: dated tasks reach the lock screen through Apple Reminders.

import { LOG_PREFIX } from "./log";
import type { SpendSummary } from "./signals";

export interface Glance {
  version: 1;
  at: number;
  spending: null | {
    /** Amounts are left out when the owner turned on "Do not show amounts on the lock screen". */
    today: number | null; week: number | null; todayCount: number; currency: string;
    /** Percent of each target spent (0–999), or null when that target is not set. */
    dayPct: number | null; weekPct: number | null; hidden: boolean;
  };
  notes: { inbox: number; lastLog: { time: string; text: string } | null };
}

const TRIAGED = /^Daybook-status:\s*(?:kept|task|goal|archived)\s*$/im;
const pct = (spent: number, target: number | null) => target ? Math.min(999, Math.round(spent / target * 100)) : null;

export function buildGlance(input: {
  now: number; date: string; spend: SpendSummary | null; hideAmounts: boolean;
  dailyTarget: number | null; weeklyTarget: number | null;
  notes: readonly { name: string; content: string }[];
}): Glance {
  const s = input.spend;
  const inbox = input.notes.filter(n => n.name.startsWith("inbox/") && !TRIAGED.test(n.content)).length;
  const today = input.notes.find(n => n.name === LOG_PREFIX + input.date + ".md");
  const lines = (today?.content ?? "").split("\n").map(l => /^- (\d{2}:\d{2}) (.*)$/.exec(l)).filter(Boolean) as RegExpExecArray[];
  const last = lines.at(-1);
  // Tags and "Tap to pay:" prefixes are noise at lock screen size.
  const text = last ? last[2].replace(/\s*#[\w-]+/g, "").replace(/^Tap to pay:\s*/i, "").trim().slice(0, 40) : "";
  return {
    version: 1, at: input.now,
    spending: s ? {
      today: input.hideAmounts ? null : s.today, week: input.hideAmounts ? null : s.weekTotal,
      todayCount: s.todayCount, currency: s.currency,
      dayPct: pct(s.today, input.dailyTarget), weekPct: pct(s.weekTotal, input.weeklyTarget), hidden: input.hideAmounts
    } : null,
    notes: { inbox, lastLog: last && text ? { time: last[1], text } : null }
  };
}
