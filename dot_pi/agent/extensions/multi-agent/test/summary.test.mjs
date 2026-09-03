import assert from "node:assert/strict";
import test from "node:test";
import {
  SUMMARY_MAX_CHARS,
  fallbackSummary,
  normalizeSummary,
} from "../summary.mjs";

test("normalizeSummary rejects missing, blank, or non-string summaries", () => {
  assert.throws(
    () => normalizeSummary(undefined, "scout"),
    /requires a short one-line 'summary'/,
  );
  assert.throws(() => normalizeSummary("", "scout"), /requires a short/);
  assert.throws(() => normalizeSummary(" \t\n ", "reviewer"), /requires a short/);
  assert.throws(() => normalizeSummary(42, "scout"), /requires a short/);
  assert.throws(() => normalizeSummary({}, "scout"), /requires a short/);
  assert.throws(
    () => normalizeSummary(undefined, "feasibility"),
    /delegated feasibility task/,
  );
});

test("normalizeSummary folds whitespace into a single line", () => {
  assert.equal(
    normalizeSummary("  Audit the API surface.  ", "scout"),
    "Audit the API surface.",
  );
  assert.equal(
    normalizeSummary("First line\nsecond line\twith  spaces", "scout"),
    "First line second line with spaces",
  );
  assert.ok(!normalizeSummary("a\nb", "scout").includes("\n"));
});

test("normalizeSummary enforces the shared UTF-16 character budget", () => {
  const accepted = "a".repeat(SUMMARY_MAX_CHARS);
  assert.equal(normalizeSummary(accepted, "scout"), accepted);
  assert.throws(
    () => normalizeSummary("a".repeat(SUMMARY_MAX_CHARS + 1), "scout"),
    /must be <= 160 characters/,
  );
});

test("normalizeSummary counts astral characters in UTF-16 units like maxLength", () => {
  // Each emoji is one code point but two UTF-16 units: 80 pass (160 units),
  // 81 would exceed the schema maxLength and must be rejected here too.
  assert.equal(normalizeSummary("x".repeat(158) + "🙂", "scout").length, 160);
  assert.throws(
    () => normalizeSummary("x".repeat(159) + "🙂", "scout"),
    /must be <= 160 characters/,
  );
  assert.throws(
    () => normalizeSummary("🙂".repeat(81), "scout"),
    /must be <= 160 characters/,
  );
});

test("fallbackSummary uses the trimmed first task line", () => {
  assert.equal(
    fallbackSummary("Inspect the repo\nand report findings"),
    "Inspect the repo",
  );
  assert.equal(fallbackSummary("  \n"), "");
  assert.equal(fallbackSummary(undefined), "");
  assert.equal(fallbackSummary(42), "42");
});

test("fallbackSummary caps legacy text at SUMMARY_MAX_CHARS code points", () => {
  const long = "x".repeat(300);
  const out = fallbackSummary(long);
  assert.equal(Array.from(out).length, SUMMARY_MAX_CHARS);
  const emojiOut = fallbackSummary("🙂".repeat(300));
  assert.equal(Array.from(emojiOut).length, SUMMARY_MAX_CHARS);
  // Slicing on code point boundaries must not leave lone surrogates behind.
  assert.equal(emojiOut.isWellFormed(), true);
  assert.equal(emojiOut, "🙂".repeat(SUMMARY_MAX_CHARS));
});
