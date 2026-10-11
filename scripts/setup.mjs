#!/usr/bin/env node
// Deploys your own copy of the notes server to your Cloudflare account and stores your settings as secrets.
// Usage (from the cloudflare/ folder): npm install && npm run setup
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const rl = createInterface({ input: stdin, output: stdout });
const ask = async (q, fallback = "") => (await rl.question(fallback ? `${q} [${fallback}]: ` : `${q}: `)).trim() || fallback;
const wrangler = (args, opts = {}) => spawnSync("npx", ["wrangler", ...args], { stdio: "inherit", shell: process.platform === "win32", ...opts });
const fail = (msg) => { console.error("\n✗ " + msg); process.exit(1); };

console.log("\nPersonal Notes MCP setup\n");
console.log("Before you start you need:");
console.log("  1. A PRIVATE GitHub repo for your notes (created with 'Add a README' ticked).");
console.log("  2. A fine-grained GitHub token for only that repo, with Contents: Read and write.");
console.log("     https://github.com/settings/personal-access-tokens/new");
console.log("  3. A free Cloudflare account (the next step opens a browser to sign in).\n");

const whoami = wrangler(["whoami"], { stdio: "pipe", encoding: "utf8" });
if (whoami.status !== 0 || !/logged in/i.test((whoami.stdout ?? "") + (whoami.stderr ?? "")) || /not authenticated/i.test(whoami.stdout ?? "")) {
  if (wrangler(["login"]).status !== 0) fail("Cloudflare login failed.");
}

const repo = await ask("Notes repo (owner/repo)");
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) fail("Use the form owner/repo, e.g. jane/notes-data.");
const tz = await ask("Time zone", Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles");
try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { fail(`Unknown time zone: ${tz}`); }
const ghToken = await ask("GitHub token (github_pat_...)");
if (!ghToken) fail("A GitHub token is required.");

// Check the token can see the repo before deploying anything.
const check = await fetch(`https://api.github.com/repos/${repo}/contents?ref=main`, {
  headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json", "User-Agent": "notes-setup" }
});
if (check.status === 404) fail(`The token can't see ${repo}, or it has no main branch. Check the token's repository access and that the repo has a README.`);
if (check.status === 401) fail("GitHub rejected the token.");
if (!check.ok) fail(`GitHub returned ${check.status} for ${repo}.`);

console.log("\nOptional: phone push notifications through Pushover (https://pushover.net). Leave blank to skip; you can add them later.");
const pushoverUser = await ask("Pushover user key");
const pushoverToken = pushoverUser ? await ask("Pushover application API token") : "";
rl.close();

const bearer = randomBytes(32).toString("hex");

console.log("\nDeploying…");
const deploy = wrangler(["deploy"], { stdio: ["inherit", "pipe", "inherit"], encoding: "utf8" });
stdout.write(deploy.stdout ?? "");
if (deploy.status !== 0) fail("Deploy failed (see above).");
const url = (deploy.stdout.match(/https:\/\/[\w.-]+\.workers\.dev/) ?? [])[0];

const secrets = { NOTES_REPO: repo, NOTES_TIMEZONE: tz, GITHUB_TOKEN: ghToken, MCP_BEARER_TOKEN: bearer };
if (pushoverUser && pushoverToken) Object.assign(secrets, { PUSHOVER_USER: pushoverUser, PUSHOVER_TOKEN: pushoverToken });
console.log("\nSaving settings as Cloudflare secrets…");
const put = wrangler(["secret", "bulk"], { input: JSON.stringify(secrets), stdio: ["pipe", "inherit", "inherit"] });
if (put.status !== 0) fail("Saving secrets failed. Re-run `npm run setup`.");

const base = url ?? "https://personal-notes-mcp.<your-subdomain>.workers.dev";
console.log(`
✓ Done.

Your password (save it in your password manager now; it is not shown again):
  ${bearer}

Connect Claude: Settings → Connectors → Add custom connector
  URL: ${base}/mcp
  When the sign-in page opens, paste the password above and click Allow.

Phone web app: ${base}/app  (unlock with the same password; Share → Add to Home Screen)
`);
