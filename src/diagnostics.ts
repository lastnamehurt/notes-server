import { GithubNotes, type Env } from "./github";
import { scheduler } from "./core";
import { pushConfigured } from "./reminder-parse";
import { notesFor } from "./storage";

type Status = "pass" | "warning" | "fail";
export type Diagnostic = { id: string; status: Status; message: string };
export type DiagnosticReport = { status: Status; checkedAt: string; checks: Diagnostic[] };
export async function runDiagnostics(env: Env): Promise<DiagnosticReport> {
  const checks: Diagnostic[] = [];
  const add = (id: string, status: Status, message: string) => checks.push({ id, status, message });
  add("auth", env.MCP_BEARER_TOKEN ? "pass" : "fail",
    env.MCP_BEARER_TOKEN ? "Authentication is configured" : "Authentication is missing");
  if (env.NOTES_STORAGE === "app") {
    try {
      const count = (await notesFor(env).list()).length;
      add("storage", "pass", `Notes are stored in this app (${count} note${count === 1 ? "" : "s"})`);
    } catch { add("storage", "fail", "This app's note storage is unavailable"); }
  } else if (!env.NOTES_REPO || !env.GITHUB_TOKEN) {
    add("github", "fail", "Connect your GitHub notes repository");
  } else {
    try {
      await notesFor(env).list();
      add("github", "pass", "GitHub notes are readable");
      const response = await fetch((env.GITHUB_API_URL || "https://api.github.com") + "/repos/" + env.NOTES_REPO.trim(), {
        headers: { Authorization: "Bearer " + env.GITHUB_TOKEN, Accept: "application/vnd.github+json", "User-Agent": "personal-notes-mcp" }
      });
      if (!response.ok) add("privacy", "fail", "Cannot verify repository privacy");
      else {
        const repo = await response.json() as { private?: boolean; permissions?: { push?: boolean } };
        add("privacy", repo.private === true ? "pass" : "fail",
          repo.private === true ? "Repository is private" : "Repository is not confirmed private");
        add("write", repo.permissions?.push === true ? "pass" : "warning",
          repo.permissions?.push === true ? "Write access confirmed" : "Write access could not be confirmed");
      }
    } catch { add("github", "fail", "GitHub repository is not accessible"); }
  }
  try {
    const error = await scheduler(env).lastError();
    add("reminders", error ? "warning" : "pass",
      error ? "Reminder delivery error recorded" : "Reminder scheduler is responding");
  } catch { add("reminders", "fail", "Reminder scheduler is unavailable"); }
  add("notifications", pushConfigured(env) ? "pass" : "warning",
    pushConfigured(env) ? "Push notifications configured" : "Push notifications not configured");
  add("backup", "pass", "Backup and restore API installed; full recovery must be tested separately");
  return { status: checks.some(c => c.status === "fail") ? "fail" :
    checks.some(c => c.status === "warning") ? "warning" : "pass",
    checkedAt: new Date().toISOString(), checks };
}
