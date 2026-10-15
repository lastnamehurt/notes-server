import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SIGNAL_SETTINGS, parseSignalSettings, parsePayment, parseAmount, categoryLabel,
  dayAndWeek, spendSummary, paymentOutcome, type Payment, type SignalSettings
} from "../src/signals.ts";

const zone = "America/Los_Angeles";
const on = (patch: Partial<SignalSettings["payment"]> = {}, hideAmounts = false): SignalSettings =>
  ({ payment: { ...DEFAULT_SIGNAL_SETTINGS.payment, enabled: true, ...patch }, hideAmounts });
// Thursday 2026-10-15, 18:00 Pacific.
const T = Date.parse("2026-10-16T01:00:00Z");
const pay = (id: string, amount: number, category = "groceries", at = T, card = "Personal"): Payment =>
  ({ id: "pay-" + id.padStart(4, "0"), at, amount, currency: "USD", card, category });

test("defaults are off and valid; bad settings are refused", () => {
  assert.equal(DEFAULT_SIGNAL_SETTINGS.payment.enabled, false);
  assert.deepEqual(parseSignalSettings(DEFAULT_SIGNAL_SETTINGS), DEFAULT_SIGNAL_SETTINGS);
  for (const bad of [null, {}, { ...on(), hideAmounts: "yes" }, { ...on(), payment: { ...on().payment, bigPurchase: -1 } },
    { ...on(), payment: { ...on().payment, categories: { "Bad Label": "drink" } } },
    { ...on(), payment: { ...on().payment, categories: { bar: "party" } } },
    { ...on(), payment: { ...on().payment, drinkGoalPerWeek: 1.5 } }])
    assert.throws(() => parseSignalSettings(bad));
});

test("payments read the way Shortcuts sends them, and never keep a merchant", () => {
  assert.equal(parseAmount("$1,234.56"), 1234.56);
  assert.equal(parseAmount(12.5), 12.5);
  assert.equal(parseAmount("free"), null);
  assert.equal(parseAmount(0), null);
  assert.equal(categoryLabel("Food & Drink"), "food-drink");
  assert.equal(categoryLabel(""), "other");
  const p = parsePayment({ amount: "$8.75", card: "  Apple Card ", category: "Bar", merchant: "Secret Lounge", id: "run-12345678" }, T);
  assert.deepEqual(p, { id: "run-12345678", at: T, amount: 8.75, currency: "USD", card: "Apple Card", category: "bar" });
  assert.ok(!JSON.stringify(p).includes("Secret"));
  assert.throws(() => parsePayment({ amount: "abc" }, T), /amount/);
  assert.throws(() => parsePayment({ amount: 5, id: "x" }, T), /id must be/);
  assert.match(parsePayment({ amount: 5 }, T).id, /^[\w-]{8,}$/);
});

test("days and Monday-start weeks follow the owner's time zone", () => {
  assert.deepEqual(dayAndWeek(T, zone), { date: "2026-10-15", week: "2026-10-12" });
  assert.deepEqual(dayAndWeek(Date.parse("2026-10-19T06:00:00Z"), zone), { date: "2026-10-18", week: "2026-10-12" });
  assert.deepEqual(dayAndWeek(Date.parse("2026-10-19T08:00:00Z"), zone), { date: "2026-10-19", week: "2026-10-19" });
});

test("spend totals skip ignored cards, other currencies and last week", () => {
  const stored = [pay("1", 10), pay("2", 20.5, "bar"), pay("3", 99, "other", T, "Work Amex"),
    { ...pay("4", 50), currency: "EUR" }, pay("5", 7, "coffee", T - 2 * 86_400_000), pay("6", 300, "other", T - 7 * 86_400_000)];
  const s = spendSummary(stored, on({ ignoredCards: ["work amex"] }), T, zone);
  assert.deepEqual(s, { date: "2026-10-15", week: "2026-10-12", today: 30.5, todayCount: 2, weekTotal: 37.5, weekCount: 3, drinksThisWeek: 1, currency: "USD" });
});

test("a bar tap logs a drink; food logs food; others only count", () => {
  const settings = on();
  assert.equal(paymentOutcome(pay("1", 12, "bar"), [pay("1", 12, "bar")], settings, zone).log, "Tap to pay: bar #drink #spend");
  assert.equal(paymentOutcome(pay("2", 5, "coffee"), [pay("2", 5, "coffee")], settings, zone).log, "Tap to pay: coffee #food #spend");
  assert.equal(paymentOutcome(pay("3", 40), [pay("3", 40)], settings, zone).log, null);
});

test("an ignored card does nothing at all", () => {
  const p = pay("1", 500, "bar", T, "Work");
  const r = paymentOutcome(p, [p], on({ ignoredCards: ["Work"], drinkGoalPerWeek: 0 }), zone);
  assert.deepEqual([r.counted, r.log, r.suggestions.length], [false, null, 0]);
});

test("big purchases ask once per payment; amounts stay off the lock screen when hidden", () => {
  const p = pay("1", 150);
  const shown = paymentOutcome(p, [p], on(), zone).suggestions;
  assert.deepEqual(shown.map(s => s.ruleId), ["payment-big-purchase"]);
  assert.match(shown[0].reason, /\$150 purchase.*\$150 limit/);
  const hiddenReason = paymentOutcome(p, [p], { ...on(), hideAmounts: true }, zone).suggestions[0].reason;
  assert.doesNotMatch(hiddenReason, /\$/);
  assert.deepEqual(paymentOutcome(pay("2", 149.99), [pay("2", 149.99)], on(), zone).suggestions, []);
  assert.deepEqual(paymentOutcome(p, [p], on({ bigPurchase: null }), zone).suggestions, []);
});

test("the drink goal speaks up past the goal, once per new tab", () => {
  const settings = on({ drinkGoalPerWeek: 2, bigPurchase: null });
  const tabs = [pay("1", 10, "bar", T - 86_400_000), pay("2", 10, "bar", T - 3600_000)];
  assert.deepEqual(paymentOutcome(tabs[1], tabs, settings, zone).suggestions, [], "at the goal is fine");
  const third = pay("3", 10, "bar");
  const r = paymentOutcome(third, [...tabs, third], settings, zone).suggestions;
  assert.equal(r.length, 1);
  assert.equal(r[0].reason, "That's 3 bar tabs this week. Your goal is 2.");
  assert.equal(r[0].dedupeKey, "payment-drink-goal:2026-10-12:3");
});

test("spend targets fire only on the tap that crosses them", () => {
  const settings = on({ dailyTarget: 50, weeklyTarget: 100, bigPurchase: null });
  const a = pay("1", 40, "other", T - 2 * 86_400_000), b = pay("2", 30, "other", T - 3600_000), c = pay("3", 40), d = pay("4", 5);
  assert.deepEqual(paymentOutcome(b, [a, b], settings, zone).suggestions, []);
  const crossing = paymentOutcome(c, [a, b, c], settings, zone).suggestions;
  assert.deepEqual(crossing.map(s => s.dedupeKey), ["payment-spend-target:day:2026-10-15", "payment-spend-target:week:2026-10-12"]);
  assert.deepEqual(paymentOutcome(d, [a, b, c, d], settings, zone).suggestions, [], "already over: no repeat");
});
