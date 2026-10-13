// Daybook installer: a page that sets up Daybook in a person's own Cloudflare account with an API token they
// create, plus the app bundle that installed apps download when they update themselves. The token is used for
// the request it arrives with and never stored or logged here.
import page from "./page.html";
import { manifest, files } from "../bundle/index";
import { AlreadyInstalled, CF_API, Cloudflare, checkAccount, friendly, install, replaceKey, update, type Bundle, type Manifest } from "../../src/cloudflare-deploy";

interface Env { CF_API_URL?: string; READY_HOST_SUFFIX?: string }

const bundle: Bundle = { manifest: manifest as Manifest, files };

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
});
const fail = (error: string, status = 400, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);

/** "jane.doe@example.com's Account" → "janedoe". */
export function suggestSubdomain(accountName: string): string {
  const base = accountName.split("@")[0].replace(/'s account$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base.length >= 3 ? base.slice(0, 40) : "";
}

async function body(request: Request): Promise<Record<string, string | undefined>> {
  try { return await request.json(); } catch { return {}; }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cf = (token: string) => new Cloudflare(token, env.CF_API_URL || CF_API);
    const path = url.pathname, method = request.method;

    if (method === "GET" && (path === "/" || path === "/install"))
      return new Response(page, { headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        "Referrer-Policy": "no-referrer"
      } });
    if (path === "/health") return new Response("ok");

    // The app bundle, for installed apps' Update now. Public: it's the same code as the open-source repository.
    if (method === "GET" && path === "/bundle/manifest.json")
      return new Response(JSON.stringify(manifest), { headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" } });
    if (method === "GET" && path.startsWith("/bundle/files/")) {
      const name = decodeURIComponent(path.slice("/bundle/files/".length));
      const file = files.get(name);
      if (file === undefined) return new Response("Not found", { status: 404 });
      return new Response(file, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" } });
    }

    if (method === "POST" && path === "/api/check") {
      const { token, name, accountId } = await body(request);
      if (!token?.trim()) return fail("Paste your key first.");
      try {
        const info = await checkAccount(cf(token.trim()), name || undefined, accountId || undefined);
        return json({ accountName: info.accountName, subdomain: info.subdomain, existing: info.existing, suggestion: suggestSubdomain(info.accountName) });
      } catch (e) { return fail(friendly(e)); }
    }

    if (method === "POST" && path === "/api/install") {
      const { token, password, subdomain, name, accountId } = await body(request);
      if (!token?.trim()) return fail("Paste your key first.");
      if (!password || password.length < 12) return fail("Choose a password of at least 12 characters.");
      try {
        const r = await install(cf(token.trim()), bundle, {
          token: token.trim(), password, subdomain, name: name || undefined, accountId: accountId || undefined, installerUrl: url.origin
        });
        return json({ url: r.url, version: manifest.version });
      } catch (e) {
        if (e instanceof AlreadyInstalled) return fail(e.message, 409, { existing: e.url });
        return fail(friendly(e));
      }
    }

    // Already installed: bring it up to date with this key, and give the app the key for future updates.
    if (method === "POST" && path === "/api/update") {
      const { token, name, accountId } = await body(request);
      if (!token?.trim()) return fail("Paste your key first.");
      try {
        const api = cf(token.trim());
        const info = await checkAccount(api, name || undefined, accountId || undefined);
        if (!info.existing) return fail("Daybook isn't installed in this Cloudflare account yet.");
        const r = await update(api, bundle, { accountId: info.accountId, name: name || undefined });
        await replaceKey(api, { accountId: info.accountId, name: name || undefined, token: token.trim() });
        return json({ url: info.existing, version: r.version });
      } catch (e) { return fail(friendly(e)); }
    }

    // Is the new app answering yet? Only ever checks a workers.dev app's /health.
    if (method === "POST" && path === "/api/ready") {
      const { url: target } = await body(request);
      const suffix = env.READY_HOST_SUFFIX || ".workers.dev";
      let health: URL;
      try { health = new URL("/health", target); } catch { return fail("Bad address"); }
      if (!health.hostname.endsWith(suffix) || (health.protocol !== "https:" && !env.READY_HOST_SUFFIX)) return fail("Bad address");
      try {
        const r = await fetch(health.toString(), { redirect: "manual" });
        return json({ ready: r.ok && (await r.text()).trim() === "ok" });
      } catch { return json({ ready: false }); }
    }

    return new Response("Not found", { status: 404 });
  }
};
