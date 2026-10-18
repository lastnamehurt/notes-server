// Daybook lock screen widget for Scriptable (https://scriptable.app).
// Shows today's spending and a glance at your notes: the inbox count and the last thing you logged.
// Setup: docs/lock-screen-widget.md. Run this script in Scriptable one time to paste your address and
// secret. They are kept in the iPhone Keychain, never in this file.

const KEY_ADDRESS = "daybook.address";
const KEY_SECRET = "daybook.secret";

// ---------- Setup (when you run the script in the Scriptable app) ----------

async function askForSetup() {
  const alert = new Alert();
  alert.title = "Daybook widget";
  alert.message = "Paste your Daybook address and your Shortcut secret. You find both in Daybook: Settings → Shortcuts.";
  alert.addTextField("https://your-daybook.workers.dev", Keychain.contains(KEY_ADDRESS) ? Keychain.get(KEY_ADDRESS) : "");
  alert.addSecureTextField("Shortcut secret", "");
  alert.addAction("Save");
  alert.addCancelAction("Cancel");
  if (await alert.presentAlert() === -1) return false;
  // Any Daybook address works (for example the Tap to pay one): only the start is kept.
  const match = /^https?:\/\/[^/\s]+/i.exec(alert.textFieldValue(0).trim());
  const secret = alert.textFieldValue(1).trim();
  if (!match) { await notice("That address does not start with https://. Copy it again from Settings → Shortcuts."); return false; }
  Keychain.set(KEY_ADDRESS, match[0]);
  if (secret) Keychain.set(KEY_SECRET, secret);
  return true;
}

async function notice(text) {
  const a = new Alert(); a.title = "Daybook widget"; a.message = text; a.addAction("OK"); await a.presentAlert();
}

// ---------- Data ----------

async function loadGlance() {
  const request = new Request(Keychain.get(KEY_ADDRESS) + "/app/shortcuts/glance");
  request.headers = { Authorization: "Bearer " + Keychain.get(KEY_SECRET) };
  request.timeoutInterval = 15;
  const data = await request.loadJSON();
  const status = request.response && request.response.statusCode;
  if (status === 401) throw new Error("The secret is not correct");
  if (status && status >= 400) throw new Error((data && data.error) || "Daybook said " + status);
  return data;
}

const money = n => "$" + (n >= 100 ? Math.round(n) : n.toFixed(2));
const shortMoney = n => "$" + Math.round(n);
function time12(hhmm) {
  let [h, m] = hhmm.split(":").map(Number); const ap = h >= 12 ? "pm" : "am"; h = h % 12 || 12;
  return h + (m ? ":" + String(m).padStart(2, "0") : "") + ap;
}

/** "$10.44 today · $43 week", or targets only when amounts are hidden. */
function spendLine(s) {
  if (!s) return "Spending is off";
  if (s.hidden) {
    const parts = [];
    if (s.dayPct !== null) parts.push("Day " + s.dayPct + "%");
    if (s.weekPct !== null) parts.push("Week " + s.weekPct + "%");
    return parts.length ? parts.join(" · ") : s.todayCount + (s.todayCount === 1 ? " payment" : " payments") + " today";
  }
  return money(s.today) + " today · " + money(s.week) + " week";
}
function notesLine(n) {
  return n.inbox ? n.inbox + " in inbox" : "Inbox clear";
}
function lastLine(n) {
  return n.lastLog ? time12(n.lastLog.time) + " " + n.lastLog.text : "Nothing logged today";
}

// ---------- Widget ----------

function build(glance, error) {
  const family = config.widgetFamily || "accessoryRectangular";
  const w = new ListWidget();
  w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000); // iOS decides; this is the earliest.
  if (Keychain.contains(KEY_ADDRESS)) w.url = Keychain.get(KEY_ADDRESS) + "/app#spending";
  const text = (stack, value, font, opacity = 1) => {
    const t = stack.addText(value); t.font = font; t.textOpacity = opacity; t.lineLimit = 1; t.minimumScaleFactor = 0.7; return t;
  };

  if (error) {
    text(w, family === "accessoryCircular" ? "!" : "Daybook: " + error, Font.semiboldSystemFont(12));
    return w;
  }
  const s = glance.spending, n = glance.notes;

  if (family === "accessoryInline") {
    w.addText(s ? spendLine(s) : notesLine(n)); // inline shows one text only
  } else if (family === "accessoryCircular") {
    w.addAccessoryWidgetBackground = true;
    const pctValue = s && s.dayPct !== null ? s.dayPct : null;
    const top = pctValue !== null ? pctValue + "%" : s && !s.hidden ? shortMoney(s.today) : String(n.inbox);
    const bottom = pctValue !== null ? "day" : s && !s.hidden ? "today" : "inbox";
    w.addSpacer();
    const a = text(w, top, Font.boldRoundedSystemFont(15)); a.centerAlignText();
    const b = text(w, bottom, Font.systemFont(10), 0.8); b.centerAlignText();
    w.addSpacer();
  } else {
    // Rectangular (lock screen) and the Home Screen sizes: three short lines.
    const big = family.startsWith("accessory") ? 14 : 17, small = family.startsWith("accessory") ? 12 : 14;
    text(w, spendLine(s), Font.semiboldSystemFont(big));
    w.addSpacer(2);
    text(w, notesLine(n), Font.systemFont(small), 0.85);
    text(w, lastLine(n), Font.systemFont(small), 0.85);
    if (!family.startsWith("accessory")) { w.addSpacer(); text(w, "Daybook", Font.mediumSystemFont(11), 0.5); }
  }
  return w;
}

// ---------- Run ----------

async function main() {
  let ready = Keychain.contains(KEY_ADDRESS) && Keychain.contains(KEY_SECRET);
  if (config.runsInApp) {
    if (ready) {
      const again = new Alert();
      again.title = "Daybook widget"; again.message = "Your address and secret are saved.";
      again.addAction("Show preview"); again.addAction("Change address or secret"); again.addCancelAction("Close");
      const pick = await again.presentAlert();
      if (pick === -1) return;
      if (pick === 1) ready = await askForSetup();
    } else {
      ready = await askForSetup();
    }
  }
  let widget;
  if (!ready) widget = build(null, "open Scriptable to set up");
  else {
    try { widget = build(await loadGlance(), null); }
    catch (e) { widget = build(null, e.message || "cannot reach Daybook"); }
  }
  if (config.runningInWidget) Script.setWidget(widget);
  else await widget.presentAccessoryRectangular();
}

await main();
Script.complete();
