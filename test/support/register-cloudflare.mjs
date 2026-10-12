// Resolve "cloudflare:workers" to the test stand-in (used with: tsx --import ./test/support/register-cloudflare.mjs).
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return { url: ${JSON.stringify(new URL("./cloudflare-workers.mjs", import.meta.url).href)}, shortCircuit: true };
    return next(specifier, context);
  }`));
