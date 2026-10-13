import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeZip, crc32 } from "../src/zip.ts";

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("zip opens with a standard reader, with folders and non-ASCII text intact", () => {
  const files = new Map([
    ["inbox/2026-10-12-groceries.md", "# Groceries\neggs, café ✓\n"],
    ["journal/log/2026-10-12.md", "# Log 2026-10-12\n\n- 08:00 tea #drink\n"],
    ["goals/2026-10-01-run.md", ""]
  ]);
  const dir = mkdtempSync(join(tmpdir(), "zip-"));
  const path = join(dir, "notes.zip");
  writeFileSync(path, makeZip(files, new Date(Date.UTC(2026, 9, 12, 18, 30, 0))));
  const listing = JSON.parse(execFileSync("python3", ["-c", `
import zipfile, json, sys
z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
print(json.dumps({i.filename: z.read(i).decode() for i in z.infolist()}))`, path]).toString());
  assert.deepEqual(listing, Object.fromEntries(files));
});
