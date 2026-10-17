// Daybook Signals (#147): small, labelled events sent by iPhone Shortcuts automations, such as a tap to
// pay. Pure parsing and rules; storage lives in the scheduler Durable Object. Never stores merchant
// names or coordinates: a payment is an amount, a currency, a card label and a category label.

import { localStamp } from "./reminder-parse";
import { parseTaskLine } from "./apple-sync";
import { LOG_PREFIX } from "./log";

export type CategoryAction = "drink" | "food" | "none";
export interface SignalSettings {
  payment: {
    enabled: boolean;
    /** Card labels (as the Shortcut sends them) to leave out of totals, e.g. a work card. */
    ignoredCards: string[];
    dailyTarget: number | null;
    weeklyTarget: number | null;
    /** A single tap at or above this asks "Was this planned?". null turns it off. */
    bigPurchase: number | null;
    drinkGoalPerWeek: number | null;
    /** Category label → what a tap there means. Unlisted categories only count toward spend. */
    categories: Record<string, CategoryAction>;
  };
  /** Parked: a Shortcut reports kinds of place nearby; Daybook answers with tasks tagged @at:<place>. */
  parked: { enabled: boolean };
  /** Keep amounts off the lock screen (suggestion text that may be pushed). */
  hideAmounts: boolean;
}

export const DEFAULT_SIGNAL_SETTINGS: SignalSettings = {
  payment: {
    enabled: false, ignoredCards: [], dailyTarget: null, weeklyTarget: null, bigPurchase: 150, drinkGoalPerWeek: null,
    categories: { bar: "drink", nightlife: "drink", brewery: "drink", "liquor-store": "drink", restaurant: "food", coffee: "food", "fast-food": "food",
      food: "food", gas: "none", grocery: "none", parking: "none" }
  },
  parked: { enabled: false },
  hideAmounts: true
};

const LABEL = /^[a-z0-9][a-z0-9-]{0,39}$/;
const money = (v: unknown, max = 1_000_000) => v === null || (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= max);

export function parseSignalSettings(input: unknown): SignalSettings {
  const bad = () => { throw new Error("Invalid signal settings"); };
  if (!input || typeof input !== "object" || Array.isArray(input)) bad();
  const x = input as Record<string, unknown>;
  const p = x.payment as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object" || typeof p.enabled !== "boolean" || typeof x.hideAmounts !== "boolean") bad();
  // Settings saved before the parked signal existed have no "parked": treat it as off.
  const parked = x.parked === undefined ? { enabled: false } : x.parked as Record<string, unknown>;
  if (!parked || typeof parked !== "object" || typeof parked.enabled !== "boolean") bad();
  if (!Array.isArray(p!.ignoredCards) || p!.ignoredCards.length > 50 ||
      p!.ignoredCards.some(c => typeof c !== "string" || !c.trim() || c.length > 60)) bad();
  for (const k of ["dailyTarget", "weeklyTarget", "bigPurchase"]) if (!money(p![k])) bad();
  const goal = p!.drinkGoalPerWeek;
  if (!(goal === null || (Number.isInteger(goal) && (goal as number) >= 0 && (goal as number) <= 100))) bad();
  const cats = p!.categories as Record<string, unknown>;
  if (!cats || typeof cats !== "object" || Array.isArray(cats) || Object.keys(cats).length > 50 ||
      Object.entries(cats).some(([k, v]) => !LABEL.test(k) || !["drink", "food", "none"].includes(String(v)))) bad();
  return {
    payment: {
      enabled: p!.enabled as boolean, ignoredCards: (p!.ignoredCards as string[]).map(c => c.trim()),
      dailyTarget: p!.dailyTarget as number | null, weeklyTarget: p!.weeklyTarget as number | null,
      bigPurchase: p!.bigPurchase as number | null, drinkGoalPerWeek: goal as number | null,
      categories: cats as Record<string, CategoryAction>
    },
    parked: { enabled: parked.enabled as boolean },
    hideAmounts: x.hideAmounts as boolean
  };
}

export interface Payment { id: string; at: number; amount: number; currency: string; card: string; category: string; }

/** A category label from whatever the Shortcut sends ("Bars", "Food & Drink" → "bars", "food-drink"). */
export const categoryLabel = (v: unknown): string => {
  const s = typeof v === "string" ? v.toLowerCase().replace(/&/g, " ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) : "";
  return LABEL.test(s) ? s : "other";
};

/** Read an amount the way Shortcuts may send it: 12.5, "12.50", "$1,234.56". */
export function parseAmount(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[^0-9.\-]/g, "")) : NaN;
  return Number.isFinite(n) && n > 0 && n < 1_000_000 ? Math.round(n * 100) / 100 : null;
}

/** Validate a payment signal body. `id` makes retries idempotent; one is made when the Shortcut sends none. */
export function parsePayment(body: unknown, now: number): Payment {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Send the payment as a JSON object");
  const b = body as Record<string, unknown>;
  const amount = parseAmount(b.amount);
  if (amount === null) throw new Error("Send the amount, like 12.50");
  const currency = typeof b.currency === "string" && /^[A-Za-z]{3}$/.test(b.currency.trim()) ? b.currency.trim().toUpperCase() : "USD";
  const card = typeof b.card === "string" && b.card.trim() ? b.card.trim().slice(0, 60) : "Card";
  const given = b.id;
  if (given !== undefined && (typeof given !== "string" || !/^[\w-]{8,100}$/.test(given))) throw new Error("id must be 8-100 letters, digits, - or _");
  return { id: (given as string | undefined) ?? crypto.randomUUID(), at: now, amount, currency, card, category: categoryLabel(b.category) };
}

/** Local date and the Monday that starts its week, in the owner's time zone. */
export function dayAndWeek(at: number, timeZone: string): { date: string; week: string } {
  const date = localStamp(at, timeZone).date;
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return { date, week: d.toISOString().slice(0, 10) };
}

export interface SpendSummary { date: string; week: string; today: number; todayCount: number; weekTotal: number; weekCount: number; drinksThisWeek: number; currency: string; }

/** Totals for `now`'s day and week from stored payments (ignored cards and other currencies left out). */
export function spendSummary(payments: readonly Payment[], settings: SignalSettings, now: number, timeZone: string): SpendSummary {
  const { date, week } = dayAndWeek(now, timeZone);
  const ignored = new Set(settings.payment.ignoredCards.map(c => c.toLowerCase()));
  const currency = "USD";
  let today = 0, todayCount = 0, weekTotal = 0, weekCount = 0, drinksThisWeek = 0;
  for (const p of payments) {
    if (ignored.has(p.card.toLowerCase())) continue;
    const at = dayAndWeek(p.at, timeZone);
    if (at.week !== week) continue;
    if (settings.payment.categories[p.category] === "drink") drinksThisWeek++;
    if (p.currency !== currency) continue;
    weekTotal += p.amount; weekCount++;
    if (at.date === date) { today += p.amount; todayCount++; }
  }
  const r = (n: number) => Math.round(n * 100) / 100;
  return { date, week, today: r(today), todayCount, weekTotal: r(weekTotal), weekCount, drinksThisWeek, currency };
}

export interface SignalSuggestion {
  id: string; ownerId: "local"; ruleId: "payment-big-purchase" | "payment-drink-goal" | "payment-spend-target";
  dedupeKey: string; reason: string; createdAt: string; expiresAt: string;
  evidenceEventIds: string[]; subjectRefs: { kind: string; id: string }[];
  suggestedActions: string[]; urgency: string;
}
export interface PaymentOutcome { counted: boolean; log: string | null; suggestions: SignalSuggestion[]; summary: SpendSummary; }

const dollars = (n: number) => "$" + (Number.isInteger(n) ? String(n) : n.toFixed(2));

/**
 * What one new payment means, given the payments already stored (including it). Suggestions are
 * deduplicated by key, so a retry or a later tap never repeats one already made today or this week.
 */
export function paymentOutcome(payment: Payment, stored: readonly Payment[], settings: SignalSettings, timeZone: string): PaymentOutcome {
  const summary = spendSummary(stored, settings, payment.at, timeZone);
  const counted = !settings.payment.ignoredCards.some(c => c.toLowerCase() === payment.card.toLowerCase());
  if (!counted) return { counted, log: null, suggestions: [], summary };
  const action = settings.payment.categories[payment.category] ?? "none";
  const log = action === "drink" ? "Tap to pay: " + payment.category.replace(/-/g, " ") + " #drink #spend"
    : action === "food" ? "Tap to pay: " + payment.category.replace(/-/g, " ") + " #food #spend" : null;
  const hide = settings.hideAmounts;
  const createdAt = new Date(payment.at).toISOString();
  const suggestion = (ruleId: SignalSuggestion["ruleId"], key: string, reason: string, days: number): SignalSuggestion => ({
    id: key, ownerId: "local", ruleId, dedupeKey: key, reason, createdAt,
    expiresAt: new Date(payment.at + days * 86_400_000).toISOString(),
    evidenceEventIds: ["payment:" + payment.id], subjectRefs: [{ kind: "payment", id: payment.id }],
    suggestedActions: ["dismiss"], urgency: "normal"
  });
  const out: SignalSuggestion[] = [];
  const limit = settings.payment.bigPurchase;
  if (limit !== null && payment.currency === summary.currency && payment.amount >= limit)
    out.push(suggestion("payment-big-purchase", "payment-big-purchase:" + payment.id,
      hide ? "A bigger purchase just went through. Was it planned?"
        : `A ${dollars(payment.amount)} purchase just went through, over your ${dollars(limit)} limit. Was it planned?`, 3));
  const goal = settings.payment.drinkGoalPerWeek;
  if (action === "drink" && goal !== null && summary.drinksThisWeek > goal)
    out.push(suggestion("payment-drink-goal", `payment-drink-goal:${summary.week}:${summary.drinksThisWeek}`,
      `That's ${summary.drinksThisWeek} bar tabs this week. Your goal is ${goal}.`, 2));
  const daily = settings.payment.dailyTarget, weekly = settings.payment.weeklyTarget;
  if (daily !== null && summary.today > daily && summary.today - payment.amount <= daily)
    out.push(suggestion("payment-spend-target", "payment-spend-target:day:" + summary.date,
      hide ? "You've gone over today's spending target." : `Today's spending is ${dollars(summary.today)}, over your ${dollars(daily)} target.`, 1));
  if (weekly !== null && summary.weekTotal > weekly && summary.weekTotal - payment.amount <= weekly)
    out.push(suggestion("payment-spend-target", "payment-spend-target:week:" + summary.week,
      hide ? "You've gone over this week's spending target." : `This week's spending is ${dollars(summary.weekTotal)}, over your ${dollars(weekly)} target.`, 7));
  return { counted, log, suggestions: out, summary };
}

/* ---------- Parked (#153): tasks tagged with a kind of place ---------- */

const PLACE_TAG = /(?:^|\s)@at:([a-z0-9-]+)/gi;

/** The kinds of place a Shortcut found nearby ("Grocery Store" → "grocery-store"), at most 10. */
export function parsePlaces(body: unknown): string[] {
  const b = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const raw = Array.isArray(b.places) ? b.places : typeof b.places === "string" ? b.places.split(",") : b.place !== undefined ? [b.place] : [];
  const places = [...new Set(raw.slice(0, 10).map(categoryLabel).filter(p => p !== "other"))];
  if (!places.length) throw new Error('Send the kinds of place nearby, like "places": ["grocery"]');
  return places;
}

export interface PlaceTask { place: string; title: string; note: string; }

/** Open tasks tagged @at:<place> for any of `places`, with the tags taken out of the title. */
export function tasksForPlaces(notes: readonly { name: string; content: string }[], places: readonly string[], timeZone: string): PlaceTask[] {
  const wanted = new Set(places);
  const out: PlaceTask[] = [];
  for (const n of notes) {
    if (n.name.startsWith(LOG_PREFIX)) continue;
    for (const raw of n.content.split("\n")) {
      if (!raw.includes("@at:")) continue;
      const t = parseTaskLine(raw, timeZone);
      if (!t || t.checked) continue;
      const tags = [...t.title.matchAll(PLACE_TAG)].map(m => m[1].toLowerCase());
      const place = tags.find(tag => wanted.has(tag));
      if (!place) continue;
      const title = t.title.replace(PLACE_TAG, "").replace(/\s+/g, " ").trim();
      if (title) out.push({ place, title, note: n.name });
    }
  }
  return out;
}

/** The notification text a Shortcut shows, or "" when nothing matched. */
export function parkedMessage(tasks: readonly PlaceTask[]): string {
  const byPlace = new Map<string, string[]>();
  for (const t of tasks) byPlace.set(t.place, [...(byPlace.get(t.place) ?? []), t.title]);
  return [...byPlace].map(([place, titles]) => {
    const shown = titles.slice(0, 5).join(", ") + (titles.length > 5 ? ` and ${titles.length - 5} more` : "");
    return `Near ${place.replace(/-/g, " ")}: ${shown}`;
  }).join("\n");
}

/** This week's counted taps by kind of place, biggest first (ignored cards and other currencies left out). */
export function spendByKind(payments: readonly Payment[], settings: SignalSettings, now: number, timeZone: string): { kind: string; total: number; count: number }[] {
  const { week } = dayAndWeek(now, timeZone);
  const ignored = new Set(settings.payment.ignoredCards.map(c => c.toLowerCase()));
  const kinds = new Map<string, { total: number; count: number }>();
  for (const p of payments) {
    if (ignored.has(p.card.toLowerCase()) || p.currency !== "USD" || dayAndWeek(p.at, timeZone).week !== week) continue;
    const k = kinds.get(p.category) ?? { total: 0, count: 0 };
    k.total += p.amount; k.count++; kinds.set(p.category, k);
  }
  return [...kinds].map(([kind, k]) => ({ kind, total: Math.round(k.total * 100) / 100, count: k.count }))
    .sort((a, b) => b.total - a.total || a.kind.localeCompare(b.kind));
}
