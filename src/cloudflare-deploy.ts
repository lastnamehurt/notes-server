// Installs and updates a Daybook app in someone's own Cloudflare account through the Cloudflare API, using an
// API token they create. Used by the installer (first install) and by the app itself (Update now), so a
// person never needs GitHub, a terminal or Wrangler. Nothing here stores the token; the caller decides that.

export const CF_API = "https://api.cloudflare.com/client/v4";
export const DEFAULT_NAME = "daybook";

/** What the app needs from Cloudflare, read from wrangler.jsonc when the bundle is built. */
export interface Manifest {
  version: string;
  note?: string;
  main_module: string;
  modules: { name: string; type: string }[];
  compatibility_date: string;
  compatibility_flags: string[];
  kv: string[];
  durable_objects: { name: string; class_name: string }[];
  migrations: { tag: string; [step: string]: unknown }[];
  crons: string[];
}
export interface Bundle { manifest: Manifest; files: Map<string, Blob | string> }

export class CloudflareError extends Error {
  constructor(message: string, readonly status: number, readonly codes: number[] = []) { super(message); }
}

type Fetch = typeof fetch;

export class Cloudflare {
  constructor(private token: string, private base = CF_API, private fetcher: Fetch = (...a) => fetch(...a)) {}
  async call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, headers: { Authorization: "Bearer " + this.token } };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) { init.body = JSON.stringify(body); (init.headers as Record<string, string>)["Content-Type"] = "application/json"; }
    const res = await this.fetcher(this.base + path, init);
    const data = await res.json().catch(() => null) as { success?: boolean; result?: T; errors?: { code: number; message: string }[] } | null;
    if (!res.ok || !data || data.success === false) {
      const errors = data?.errors ?? [];
      throw new CloudflareError(errors.map(e => e.message).join("; ") || `Cloudflare said ${res.status}`, res.status, errors.map(e => e.code));
    }
    return data.result as T;
  }
}

/** Plain-words versions of the errors people are likely to hit. */
export function friendly(e: unknown): string {
  if (!(e instanceof CloudflareError)) return e instanceof Error ? e.message : String(e);
  if (e.status === 401 || e.codes.includes(10000) || e.codes.includes(9109) || e.codes.includes(6003))
    return "Cloudflare didn't accept that key. Copy it again (it's shown only once; if it's gone, make a new one with the same button).";
  if (e.status === 403) return "That key doesn't have the permissions Daybook needs. Make a new one with the Create my key button, which fills them in for you.";
  if (/verif/i.test(e.message)) return "Cloudflare needs you to verify your email address first. Open the email Cloudflare sent you, tap the link, then try again.";
  return "Cloudflare said: " + e.message;
}

export interface AccountInfo {
  accountId: string;
  accountName: string;
  /** The account's workers.dev subdomain, or null when it has none yet. */
  subdomain: string | null;
  /** Address of an app already installed under this name. */
  existing: string | null;
}

/** First look at the account a token belongs to. */
export async function checkAccount(cf: Cloudflare, name = DEFAULT_NAME, accountId?: string): Promise<AccountInfo> {
  const accounts = await cf.call<{ id: string; name: string }[]>("GET", "/accounts?per_page=50");
  const account = accountId ? accounts.find(a => a.id === accountId) : accounts[0];
  if (!account) throw new Error("That key isn't linked to a Cloudflare account. Make a new one with the Create my key button.");
  const subdomain = await getSubdomain(cf, account.id);
  const scripts = await cf.call<{ id: string }[]>("GET", `/accounts/${account.id}/workers/scripts`);
  const existing = scripts.some(s => s.id === name) && subdomain ? appUrl(name, subdomain) : null;
  return { accountId: account.id, accountName: account.name, subdomain, existing };
}

async function getSubdomain(cf: Cloudflare, accountId: string): Promise<string | null> {
  try {
    const r = await cf.call<{ subdomain?: string }>("GET", `/accounts/${accountId}/workers/subdomain`);
    return r?.subdomain || null;
  } catch (e) {
    if (e instanceof CloudflareError && (e.status === 404 || e.codes.includes(10007))) return null;
    throw e;
  }
}

export const appUrl = (name: string, subdomain: string) => `https://${name}.${subdomain}.workers.dev`;

/** Lowercase letters, numbers and dashes, 3–63 characters, not starting or ending with a dash. */
export const validSubdomain = (s: string) => /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(s);

function form(bundle: Bundle, metadata: Record<string, unknown>): FormData {
  const f = new FormData();
  f.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  for (const m of bundle.manifest.modules) {
    const body = bundle.files.get(m.name);
    if (body === undefined) throw new Error("The app bundle is missing " + m.name);
    f.append(m.name, new Blob([body], { type: m.type }), m.name);
  }
  return f;
}

const steps = (ms: Manifest["migrations"]) => ms.map(({ tag: _tag, ...step }) => step);

export interface InstallOptions {
  name?: string;
  accountId?: string;
  /** Needed only when the account has no workers.dev subdomain yet. */
  subdomain?: string;
  password: string;
  /** Kept in the app (as a secret) so it can update itself. */
  token: string;
  /** Where the app fetches new versions from. */
  installerUrl: string;
}

/** Install Daybook. Returns the app's address. */
export async function install(cf: Cloudflare, bundle: Bundle, o: InstallOptions): Promise<{ url: string; accountId: string }> {
  const name = o.name || DEFAULT_NAME;
  if (o.password.length < 12) throw new Error("Choose a password of at least 12 characters.");
  const info = await checkAccount(cf, name, o.accountId);
  if (info.existing) throw new AlreadyInstalled(info.existing);
  const acct = `/accounts/${info.accountId}`;
  let subdomain = info.subdomain;
  if (!subdomain) {
    const wanted = (o.subdomain || "").trim().toLowerCase();
    if (!validSubdomain(wanted)) throw new Error("Pick an address of 3 to 63 lowercase letters, numbers or dashes.");
    try {
      subdomain = (await cf.call<{ subdomain: string }>("PUT", `${acct}/workers/subdomain`, { subdomain: wanted })).subdomain || wanted;
    } catch (e) {
      if (e instanceof CloudflareError && (e.status === 409 || /taken|unavailable|already/i.test(e.message)))
        throw new Error(`Someone already has ${wanted}.workers.dev. Try another address.`);
      throw e;
    }
  }
  // Sign-in storage for Claude: reuse ours if a previous attempt made it.
  const kvTitle = `${name}-oauth`;
  const namespaces = await cf.call<{ id: string; title: string }[]>("GET", `${acct}/storage/kv/namespaces?per_page=100`);
  const kvId = namespaces.find(n => n.title === kvTitle)?.id
    ?? (await cf.call<{ id: string }>("POST", `${acct}/storage/kv/namespaces`, { title: kvTitle })).id;
  const m = bundle.manifest;
  const bindings = [
    ...m.kv.map(b => ({ type: "kv_namespace", name: b, namespace_id: kvId })),
    ...m.durable_objects.map(d => ({ type: "durable_object_namespace", name: d.name, class_name: d.class_name })),
    { type: "secret_text", name: "PASSWORD", text: o.password },
    { type: "secret_text", name: "CF_API_TOKEN", text: o.token },
    { type: "plain_text", name: "CF_ACCOUNT_ID", text: info.accountId },
    { type: "plain_text", name: "DAYBOOK_SCRIPT", text: name },
    { type: "plain_text", name: "DAYBOOK_INSTALLER", text: o.installerUrl }
  ];
  await cf.call("PUT", `${acct}/workers/scripts/${name}`, form(bundle, {
    main_module: m.main_module, compatibility_date: m.compatibility_date, compatibility_flags: m.compatibility_flags, bindings,
    ...(m.migrations.length ? { migrations: { new_tag: m.migrations[m.migrations.length - 1].tag, steps: steps(m.migrations) } } : {})
  }));
  await cf.call("POST", `${acct}/workers/scripts/${name}/subdomain`, { enabled: true, previews_enabled: false });
  if (m.crons.length) await cf.call("PUT", `${acct}/workers/scripts/${name}/schedules`, m.crons.map(cron => ({ cron })));
  return { url: appUrl(name, subdomain), accountId: info.accountId };
}

export class AlreadyInstalled extends Error {
  constructor(readonly url: string) { super(`Daybook is already installed in this Cloudflare account, at ${url}.`); }
}

/** Replace the app's code with `bundle`, keeping its password, settings, storage and notes. */
export async function update(cf: Cloudflare, bundle: Bundle, o: { accountId: string; name?: string }): Promise<{ version: string }> {
  const name = o.name || DEFAULT_NAME, acct = `/accounts/${o.accountId}`, m = bundle.manifest;
  const scripts = await cf.call<{ id: string; migration_tag?: string }[]>("GET", `${acct}/workers/scripts`);
  const current = scripts.find(s => s.id === name);
  if (!current) throw new Error(`There's no app called ${name} in this Cloudflare account.`);
  const tags = m.migrations.map(x => x.tag);
  let migrations: Record<string, unknown> | undefined;
  if (current.migration_tag) {
    const at = tags.indexOf(current.migration_tag);
    if (at < 0) throw new Error("This version of Daybook doesn't know how to update your app's storage. Ask for help before updating.");
    if (at < tags.length - 1) migrations = { old_tag: current.migration_tag, new_tag: tags[tags.length - 1], steps: steps(m.migrations.slice(at + 1)) };
  } else if (tags.length) {
    migrations = { new_tag: tags[tags.length - 1], steps: steps(m.migrations) };
  }
  // Storage classes come from the new code; the password, settings and sign-in storage are kept as they are.
  await cf.call("PUT", `${acct}/workers/scripts/${name}`, form(bundle, {
    main_module: m.main_module, compatibility_date: m.compatibility_date, compatibility_flags: m.compatibility_flags,
    bindings: m.durable_objects.map(d => ({ type: "durable_object_namespace", name: d.name, class_name: d.class_name })),
    keep_bindings: ["secret_text", "secret_key", "plain_text", "json", "kv_namespace"],
    ...(migrations ? { migrations } : {})
  }));
  if (m.crons.length) await cf.call("PUT", `${acct}/workers/scripts/${name}/schedules`, m.crons.map(cron => ({ cron })));
  return { version: m.version };
}

/** Remove an app and its sign-in storage (used by the live install test). */
export async function uninstall(cf: Cloudflare, o: { accountId: string; name: string }): Promise<void> {
  const acct = `/accounts/${o.accountId}`;
  await cf.call("DELETE", `${acct}/workers/scripts/${o.name}?force=true`).catch(e => { if (!(e instanceof CloudflareError && e.status === 404)) throw e; });
  const namespaces = await cf.call<{ id: string; title: string }[]>("GET", `${acct}/storage/kv/namespaces?per_page=100`);
  const kv = namespaces.find(n => n.title === `${o.name}-oauth`);
  if (kv) await cf.call("DELETE", `${acct}/storage/kv/namespaces/${kv.id}`);
}

/** Download a bundle published by the installer (manifest.json plus one file per module). */
export async function fetchBundle(baseUrl: string, fetcher: Fetch = (...a) => fetch(...a)): Promise<Bundle> {
  const base = baseUrl.replace(/\/+$/, "") + "/bundle/";
  const res = await fetcher(base + "manifest.json");
  if (!res.ok) throw new Error(`Couldn't download the new version (${res.status}). Try again in a few minutes.`);
  const manifest = await res.json() as Manifest;
  const files = new Map<string, Blob>();
  for (const mod of manifest.modules) {
    const r = await fetcher(base + "files/" + encodeURIComponent(mod.name));
    if (!r.ok) throw new Error(`Couldn't download the new version (${r.status}). Try again in a few minutes.`);
    files.set(mod.name, await r.blob());
  }
  return { manifest, files };
}

/** Give the app a new Cloudflare key (after the old one was deleted), so Update now works again. */
export async function replaceKey(cf: Cloudflare, o: { accountId: string; name?: string; token: string }): Promise<void> {
  await cf.call("PUT", `/accounts/${o.accountId}/workers/scripts/${o.name || DEFAULT_NAME}/secrets`, { name: "CF_API_TOKEN", text: o.token, type: "secret_text" });
}
