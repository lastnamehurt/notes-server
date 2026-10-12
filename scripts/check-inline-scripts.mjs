// Syntax-checks every inline <script> in the HTML the Worker serves.
// TypeScript and the unit tests never parse these, so a stray character
// (such as a literal "\n" outside a string) would otherwise ship and blank the app.
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";

const files = readdirSync("src").filter(f => f.endsWith(".html")).map(f => "src/" + f);
let failed = false;
for (const file of files) {
  const html = readFileSync(file, "utf8");
  const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html))) {
    const [, attrs, code] = match;
    if (/type\s*=\s*["'](?!module|text\/javascript)/i.test(attrs)) continue; // JSON, templates
    const line = html.slice(0, match.index).split("\n").length;
    try {
      // Compile only; nothing runs. Wrapped in an async function so top-level await parses.
      new vm.Script(`(async () => {\n${code}\n})`, { filename: file, lineOffset: line - 2 });
    } catch (err) {
      failed = true;
      const at = err.stack?.split("\n")[0] ?? "";
      console.error(`${at}: ${err.message}`);
    }
  }
}
if (failed) process.exit(1);
console.log(`Inline scripts OK (${files.join(", ")})`);
