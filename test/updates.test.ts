import { test } from "node:test";
import assert from "node:assert/strict";
import { newer, parseVersionFile } from "../src/updates.ts";
import { readFileSync } from "node:fs";

test("version comparison", () => {
  assert.equal(newer("2026.10.13", "2026.10.12"), true);
  assert.equal(newer("2026.10.12.2", "2026.10.12"), true);
  assert.equal(newer("2026.10.12", "2026.10.12"), false);
  assert.equal(newer("2026.9.30", "2026.10.1"), false);
  assert.equal(newer("2027.1.1", "2026.12.31.9"), true);
});

test("reads the published version file", () => {
  const own = parseVersionFile(readFileSync(new URL("../src/version.ts", import.meta.url), "utf8"));
  assert.match(own.version ?? "", /^\d{4}\.\d{1,2}\.\d{1,2}(\.\d+)?$/, "src/version.ts has a VERSION the parser understands");
  assert.ok((own.note ?? "").length > 10, "and a VERSION_NOTE");
  assert.deepEqual(parseVersionFile('export const VERSION = "2026.11.2";\nexport const VERSION_NOTE = "Says \\"hi\\".";'), { version: "2026.11.2", note: 'Says "hi".' });
  assert.deepEqual(parseVersionFile("garbage"), { version: undefined, note: undefined });
});

test("reads a repository name however it's pasted", async () => {
  const { parseRepo } = await import("../src/updates.ts");
  assert.equal(parseRepo("jane/notes-server"), "jane/notes-server");
  assert.equal(parseRepo("https://github.com/jane/notes-server"), "jane/notes-server");
  assert.equal(parseRepo("github.com/jane/notes-server.git"), "jane/notes-server");
  assert.equal(parseRepo("https://github.com/jane/my-daybook/actions/workflows/update-daybook.yml"), "jane/my-daybook");
  assert.equal(parseRepo(" jane/my.daybook "), "jane/my.daybook");
  assert.equal(parseRepo("notes-server"), undefined);
  assert.equal(parseRepo("https://example.com/a b"), undefined);
});
