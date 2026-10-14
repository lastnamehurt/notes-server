# End-to-end QA for the web app (/app), driven in a phone-sized Chromium with Playwright.
# Setup used when this was written:
#   python3 fake_github.py seed.json            # fake GitHub Contents API on :8798 (port is hardcoded)
#   a stub ntfy server on :8799 that logs POSTs to the file named by QA_NTFY_LOG
#   wrangler dev with GITHUB_API_URL=http://127.0.0.1:8798, NTFY_SERVER=http://127.0.0.1:8799,
#     MCP_BEARER_TOKEN=testkey, on :8790
# Configure with environment variables (defaults match the setup above, with the output in the system temp dir):
#   QA_BASE_URL  default http://localhost:8790/app
#   QA_OUT_DIR   default <tempdir>/notes-qa   (screenshots go here, and ntfy.log is read from here)
#   QA_NTFY_LOG  default <QA_OUT_DIR>/ntfy.log
# Takes ~3 minutes (waits for real reminders).
# Re-test every QA finding against the fixed app, plus regressions. Real timing: reminders go off during the run.
import time, re, json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from playwright.sync_api import sync_playwright
import os, tempfile
S = os.environ.get("QA_OUT_DIR", os.path.join(tempfile.gettempdir(), "notes-qa")); B = os.environ.get("QA_BASE_URL", "http://localhost:8790/app")
NTFY_LOG = os.environ.get("QA_NTFY_LOG", os.path.join(S, "ntfy.log"))
os.makedirs(S, exist_ok=True)
LA = ZoneInfo("America/Los_Angeles")
fails, passes = [], []
def check(cond, msg):
    (passes if cond else fails).append(msg); print(("PASS " if cond else "FAIL ") + msg)
dialog_answer = {"v": True}; dialogs = []
def on_dialog(d):
    dialogs.append(d.message); d.accept() if dialog_answer["v"] else d.dismiss()
def api(pg, method, path, body=None):
    return pg.evaluate("""async ([m, p, b]) => { const r = await fetch('/app/api' + p, {method: m, headers: b ? {'Content-Type':'application/json'} : {}, body: b ? JSON.stringify(b) : undefined}); return [r.status, await r.json().catch(() => null)]; }""", [method, path, body])
def note_text(pg, name): return api(pg, "GET", "/note?name=" + name)[1]["content"]

with sync_playwright() as p:
    br = p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
    ctx = br.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, timezone_id="America/Los_Angeles", has_touch=True, is_mobile=True)
    pg = ctx.new_page(); pg.on("dialog", on_dialog)
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(B); pg.fill("#key", "testkey"); pg.click("button[type=submit]"); pg.wait_for_selector("nav.tabs:not([hidden])")
    for n in ["inbox/2026-10-10-meds.md", "inbox/2026-10-10-errands.md", "goals/2026-10-01-ship-the-stelvio-back-on-the-road.md"]:
        api(pg, "PUT", "/note", {"name": n, "content": note_text(pg, n)})

    # Reminders that go off in ~1-2 minutes.
    now = datetime.now(LA); t1 = (now + timedelta(minutes=2)).strftime("%H:%M")
    api(pg, "POST", "/note", {"category": "inbox", "content": f"# Routine\n\n- [ ] Stretch @daily {t1}, 23:59\n- [ ] Early bird @daily {t1}\n"})
    routine = [n for n in api(pg, "GET", "/notes")[1] if "routine" in n][0]

    # Add a one-off reminder through the UI (Reminders tab -> New reminder).
    pg.goto(B + "#reminders"); pg.wait_for_selector("#newrem"); pg.click("#newrem"); pg.wait_for_selector("dialog[open]")
    pg.fill("#r-text", "Water plants"); pg.fill("#r-time1", t1)
    pg.screenshot(path=f"{S}/01-new-reminder.png"); pg.click("#r-save"); pg.wait_for_selector(".toast")
    check("Reminder added" in pg.inner_text(".toast"), "New reminder from Reminders tab, no Markdown needed")
    pg.wait_for_timeout(700)
    check("Water plants" in pg.inner_text("main"), "New reminder shows in the list")
    # Repeating reminder on custom days from a note's Add reminder.
    pg.goto(B + "#note/inbox/2026-10-10-errands.md"); pg.wait_for_selector("#addrem")
    check(pg.locator("a.back").count() == 1, "Note view has a back link")
    pg.click("#addrem"); pg.fill("#r-text", "Gym"); pg.click('[data-rep="1"]')
    for d in ["0", "2", "4", "6"]: pg.click(f'[data-day="{d}"]')   # leaves Mon, Wed, Fri
    say = pg.inner_text("#r-say"); pg.fill("#r-time2", "18:00"); pg.screenshot(path=f"{S}/02-repeat-sheet.png")
    check(say == "On Mondays, Wednesdays and Fridays", f"Repeat summary reads naturally ({say!r})")
    pg.click("#r-save"); pg.wait_for_selector(".doc"); pg.wait_for_timeout(500)
    check("- [ ] Gym @mon,wed,fri 18:00" in note_text(pg, "inbox/2026-10-10-errands.md"), "Add reminder writes the right line into the note")
    check("mon, wed, fri, 6pm" in pg.inner_text(".doc"), "Schedule shows as 'mon, wed, fri, 6pm', not raw syntax")

    # Mark one reminder done before it goes off: it must not push.
    pg.goto(B + "#today"); pg.wait_for_selector('[data-text="Early bird"]'); pg.click('[data-text="Early bird"]'); pg.wait_for_selector(".toast"); pg.wait_for_timeout(800)
    check(not pg.locator('[data-text="Early bird"]').count(), "Done early removes it from Today")

    # Log something earlier with a time.
    pg.click("#timebtn"); pg.fill("#when", "08:00"); pg.fill("#entry", "eggs and toast"); pg.click('[data-tag="food"]'); pg.click("#logbtn")
    pg.wait_for_selector(".toast:has-text('Logged')"); msg = pg.inner_text(".toast"); pg.wait_for_timeout(700)
    check(msg == "Logged at 8am", f"Log with a past time ({msg!r})")
    txt = pg.inner_text("main"); check(txt.index("eggs and toast") < txt.index("walked the dog"), "Backdated entry lands in time order")
    check(not pg.locator("#when:not([hidden])").count(), "Time resets to Now after logging")
    # Edit and delete log entries by tapping them.
    pg.click("button.entry:has-text('coffee')"); pg.wait_for_selector("dialog[open]")
    pg.screenshot(path=f"{S}/03-edit-entry.png")
    pg.fill("#l-text", "oat latte #drink"); pg.fill("#l-time", "08:25"); pg.click("#l-save"); pg.wait_for_timeout(900)
    check("oat latte" in pg.inner_text("main") and "8:25am" in pg.inner_text("main"), "Tap a log entry to edit text and time")
    pg.click("button.entry:has-text('oat latte')"); pg.click("#l-del"); pg.wait_for_timeout(900)
    check("oat latte" not in pg.inner_text("main"), "Delete a log entry")

    # Editor: tap to edit, title field, unsaved-change guards.
    pg.goto(B + "#note/inbox/2026-10-10-errands.md"); pg.wait_for_selector(".doc")
    pg.click(".doc h1"); pg.wait_for_selector("#title")
    check(pg.input_value("#title") == "Errands", "Tapping the note opens the editor with a Title field")
    pg.fill("#body", pg.input_value("#body") + "- Return library books\n")
    dialog_answer["v"] = False; pg.click("nav.tabs a[href='#reminders']"); pg.wait_for_timeout(500)
    check(bool(dialogs) and "Discard" in dialogs[-1] and pg.locator("#body").count() == 1 and "library" in pg.input_value("#body"),
          "Leaving with unsaved changes asks first; saying no keeps your text")
    dialogs.clear(); pg.click("#cancel"); pg.wait_for_timeout(300)
    check(bool(dialogs) and pg.locator("#body").count() == 1, "Cancel with changes asks first")
    dialog_answer["v"] = True
    pg.screenshot(path=f"{S}/04-editor.png")
    pg.click("#save"); pg.wait_for_selector(".doc"); pg.wait_for_timeout(300)
    check("Return library books" in note_text(pg, "inbox/2026-10-10-errands.md"), "Save persists the edit")
    check(pg.locator("#save").count() == 0 and pg.locator("#edit").count() == 1, "After saving you're back in the read view")
    # Tap a task's text to tick it.
    pg.click(".doc li.task:has-text('Call the shop') span"); pg.wait_for_selector(".toast"); pg.wait_for_timeout(400)
    check("- [x] Call the shop" in note_text(pg, "inbox/2026-10-10-errands.md"), "Tapping a checkbox's text ticks it")
    # Back link.
    pg.click("a.back"); pg.wait_for_timeout(500); check(pg.url.endswith("#notes"), "Back link returns to Notes")

    # New note with a title.
    pg.goto(B + "#new"); pg.wait_for_selector("#title"); pg.fill("#title", "Packing list"); pg.fill("#body", "- [ ] Charger\n- [ ] Passport\n")
    pg.screenshot(path=f"{S}/05-new-note.png")
    box = pg.locator("#save").bounding_box(); check(box and box["y"] < 300, "Save sits at the top, clear of the keyboard")
    pg.click("#save"); pg.wait_for_selector(".doc"); pg.wait_for_timeout(300)
    check("packing-list" in pg.url and pg.inner_text(".doc h1") == "Packing list", "New note gets its title and a matching name")

    # Goals: form, progress update, tick next step from the list.
    pg.goto(B + "#goals"); pg.wait_for_timeout(600); pg.click("a[href='#new-goal']"); pg.wait_for_selector("#g-title")
    pg.fill("#g-title", "Run a 10k"); pg.fill("#g-why", "Feel better, sleep better"); pg.fill("#g-measure", "Finish a 10k race")
    pg.fill("#g-target", "2027-03-01"); pg.fill("#g-step", "Run 2 miles three times this week")
    pg.screenshot(path=f"{S}/06-new-goal.png"); pg.click("#g-save"); pg.wait_for_selector(".doc"); pg.wait_for_timeout(300)
    gname = pg.url.split("#note/")[1]
    check(note_text(pg, gname).startswith("# Run a 10k\n\nWhy: Feel better, sleep better\nMeasure: Finish a 10k race\nTarget: 2027-03-01"), "Goal form writes a proper goal note")
    pg.click("#addupd"); pg.fill("#p-text", "Ran 2 miles, knees fine"); pg.click("#p-save"); pg.wait_for_timeout(700)
    today = datetime.now(LA).strftime("%Y-%m-%d")
    check(f"## Progress\n- {today}: Ran 2 miles, knees fine" in note_text(pg, gname), "Add update appends a dated line under Progress")
    pg.goto(B + "#goals"); pg.wait_for_selector(".goal")
    pg.screenshot(path=f"{S}/07-goals.png", full_page=True)
    pg.click(".goal:has-text('Run a 10k') .next input"); pg.wait_for_selector(".toast"); pg.wait_for_timeout(800)
    check("1 of 1 steps done" in pg.inner_text(".goal:has-text('Run a 10k')"), "Tick the next step right from the Goals list")

    # Wait for the reminders to go off.
    deadline = time.time() + 200
    while time.time() < deadline and "Water plants" not in open(NTFY_LOG).read(): time.sleep(5)
    time.sleep(4); pushes = open(NTFY_LOG).read()
    check("Water plants" in pushes and "Stretch" in pushes, "Due reminders pushed")
    check("Early bird" not in pushes, "Reminder marked done early did not push")
    pg.goto(B + "#today"); pg.reload(); pg.wait_for_selector(".rail"); pg.wait_for_timeout(600)
    pg.screenshot(path=f"{S}/08-today-due.png", full_page=True)
    t1_12 = datetime.strptime(t1, "%H:%M").strftime("%-I:%M%p").lower().replace(":00", "")
    due = pg.locator(".ev.due").all_inner_texts()
    check(any("Water plants" in d for d in due) and any("Stretch" in d for d in due), "Reminders that already went off stay on Today as Due, with Done")
    stretch_btns = pg.locator('[data-text="Stretch"]')
    check(stretch_btns.count() == 2, "Same-text reminder at two times shows twice (due now, and 11:59pm)")
    pg.locator('.ev.due [data-text="Stretch"]').click(); pg.wait_for_selector(".toast"); pg.wait_for_timeout(900)
    check(pg.locator('[data-text="Stretch"]').count() == 1 and pg.locator('.ev.up [data-text="Stretch"]').count() == 1, "Done on the due one leaves the 11:59pm one alone")
    pg.locator('.ev.due [data-text="Water plants"]').click(); pg.wait_for_selector(".toast"); pg.wait_for_timeout(900)
    rem_note = [n for n in api(pg, "GET", "/notes")[1] if "reminders" in n][0]
    check("- [x] Water plants" in note_text(pg, rem_note), "Done on a one-off ticks its box in the note")
    pg.goto(B + "#reminders"); pg.wait_for_timeout(700)
    check("Water plants" not in pg.inner_text("main"), "Done one-off is gone from Reminders")
    pg.screenshot(path=f"{S}/09-reminders.png", full_page=True)
    check(not errs, "No page errors " + str(errs[:2]))
    print(f"\n{len(passes)} passed, {len(fails)} failed")
    br.close()
