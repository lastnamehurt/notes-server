import { test } from "node:test";
import assert from "node:assert/strict";
import { ownsNotesRepo } from "../src/setup.ts";

test("the GitHub account that owns the notes repository is allowed in", () => {
  assert.equal(ownsNotesRepo("courtney", "courtney/notes"), true);
});

test("GitHub logins are compared case-insensitively", () => {
  assert.equal(ownsNotesRepo("Courtney", "courtney/notes"), true);
  assert.equal(ownsNotesRepo("COURTNEY ", "courtney/notes"), true);
});

test("any other GitHub account is refused", () => {
  assert.equal(ownsNotesRepo("someone-else", "courtney/notes"), false);
  assert.equal(ownsNotesRepo("courtney-work", "courtney/notes"), false);
});

test("nothing is allowed before a notes repository is set", () => {
  assert.equal(ownsNotesRepo("courtney", undefined), false);
  assert.equal(ownsNotesRepo("courtney", ""), false);
});
