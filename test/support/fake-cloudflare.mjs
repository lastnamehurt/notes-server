// A stand-in for the parts of the Cloudflare API the installer and Update now use: accounts, the workers.dev
// subdomain, KV namespaces, Worker uploads (multipart, with bindings, keep_bindings and storage migrations),
// workers.dev routes, cron schedules and secrets. Records everything so tests can check exactly what was sent.
import http from "node:http";

export async function startFakeCloudflare({ token, port = 0, accountName = "jane.doe@example.com's Account", subdomain = null } = {}) {
  const state = {
    accountId: "acc-1", accountName, subdomain, takenSubdomains: new Set(["taken"]),
    kv: new Map(), // id -> title
    scripts: new Map(), // name -> { tag, bindings, modules: Map<name, {type, text}>, workersDev, crons, uploads }
    calls: []
  };
  let seq = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, "http://x");
    const path = url.pathname.replace(/^\/client\/v4/, "");
    state.calls.push(req.method + " " + path);
    const send = (status, result, errors = []) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: status < 400, result: status < 400 ? result : null, errors, messages: [] }));
    };
    if (req.headers.authorization !== "Bearer " + token) return send(401, null, [{ code: 10000, message: "Authentication error" }]);
    const body = () => JSON.parse(raw.toString() || "null");

    if (req.method === "GET" && path === "/accounts") return send(200, [{ id: state.accountId, name: state.accountName }]);
    const acct = `/accounts/${state.accountId}`;
    if (!path.startsWith(acct)) return send(404, null, [{ code: 7003, message: "Could not route" }]);
    const rest = path.slice(acct.length);

    if (rest === "/workers/subdomain") {
      if (req.method === "GET") return state.subdomain ? send(200, { subdomain: state.subdomain }) : send(404, null, [{ code: 10007, message: "This account does not have a workers.dev subdomain" }]);
      if (req.method === "PUT") {
        const { subdomain } = body();
        if (state.takenSubdomains.has(subdomain)) return send(409, null, [{ code: 10036, message: "Subdomain is already taken" }]);
        state.subdomain = subdomain;
        return send(200, { subdomain });
      }
    }
    if (rest === "/storage/kv/namespaces") {
      if (req.method === "GET") return send(200, [...state.kv].map(([id, title]) => ({ id, title })));
      if (req.method === "POST") { const id = "kv-" + ++seq; state.kv.set(id, body().title); return send(200, { id, title: body().title }); }
    }
    let m = /^\/storage\/kv\/namespaces\/([^/]+)$/.exec(rest);
    if (m && req.method === "DELETE") { state.kv.delete(m[1]); return send(200, null); }

    if (rest === "/workers/scripts" && req.method === "GET")
      return send(200, [...state.scripts].map(([id, s]) => ({ id, ...(s.tag ? { migration_tag: s.tag } : {}) })));

    m = /^\/workers\/scripts\/([\w-]+)(\/.*)?$/.exec(rest);
    if (m) {
      const [, name, sub = ""] = m;
      const script = state.scripts.get(name);
      if (sub === "" && req.method === "PUT") {
        const form = await new Request("http://x", { method: "PUT", headers: { "content-type": req.headers["content-type"] }, body: raw }).formData();
        const meta = JSON.parse(await form.get("metadata").text());
        const modules = new Map();
        for (const [key, value] of form) if (key !== "metadata") modules.set(key, { type: value.type, text: await value.text() });
        if (!modules.has(meta.main_module)) return send(400, null, [{ code: 10021, message: "No such module " + meta.main_module }]);
        // Storage migrations must start from the Worker's current tag, as Cloudflare requires.
        const tag = script?.tag ?? null;
        if (meta.migrations) {
          if ((meta.migrations.old_tag ?? null) !== tag) return send(400, null, [{ code: 10079, message: `migration old_tag ${meta.migrations.old_tag} doesn't match ${tag}` }]);
        }
        const newClasses = (meta.migrations?.steps ?? []).flatMap(s => s.new_sqlite_classes ?? []);
        const known = new Set([...(script?.classes ?? []), ...newClasses]);
        for (const b of meta.bindings ?? []) if (b.type === "durable_object_namespace" && !known.has(b.class_name))
          return send(400, null, [{ code: 10074, message: "Durable Object class " + b.class_name + " needs a migration" }]);
        const kept = (script?.bindings ?? []).filter(b => (meta.keep_bindings ?? []).includes(b.type) && !(meta.bindings ?? []).some(n => n.name === b.name));
        state.scripts.set(name, {
          tag: meta.migrations?.new_tag ?? tag, classes: [...known], bindings: [...kept, ...(meta.bindings ?? [])], modules,
          compatibility_date: meta.compatibility_date, compatibility_flags: meta.compatibility_flags,
          workersDev: script?.workersDev ?? false, crons: script?.crons ?? [], uploads: (script?.uploads ?? 0) + 1, lastMetadata: meta
        });
        return send(200, { id: name });
      }
      if (!script) return send(404, null, [{ code: 10007, message: "workers.api.error.script_not_found" }]);
      if (sub === "" && req.method === "DELETE") { state.scripts.delete(name); return send(200, null); }
      if (sub === "/subdomain" && req.method === "POST") { script.workersDev = Boolean(body().enabled); return send(200, { enabled: script.workersDev }); }
      if (sub === "/schedules" && req.method === "PUT") { script.crons = body().map(s => s.cron); return send(200, { schedules: body() }); }
      if (sub === "/secrets" && req.method === "PUT") {
        const s = body();
        script.bindings = [...script.bindings.filter(b => b.name !== s.name), { type: s.type, name: s.name, text: s.text }];
        return send(200, { name: s.name, type: s.type });
      }
    }
    send(404, null, [{ code: 7003, message: "No route for " + req.method + " " + path }]);
  });
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/client/v4`;
  return { url, state, close: () => new Promise(r => server.close(r)) };
}
