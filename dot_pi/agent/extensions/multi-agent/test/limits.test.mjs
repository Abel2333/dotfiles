import assert from "node:assert/strict";
import test from "node:test";
import {
  sanitizeBounded,
  serializeBoundedActivity,
  truncateUtf8,
} from "../limits.mjs";

test("truncateUtf8 enforces a UTF-8 byte cap and retains head and tail", () => {
  const input = `HEAD-${"中🙂".repeat(10000)}-TAIL`;
  const output = truncateUtf8(input, 4096, {
    tailBytes: 1024,
    reportOmitted: true,
  });
  assert.ok(Buffer.byteLength(output, "utf8") <= 4096);
  assert.match(output, /^HEAD-/);
  assert.match(output, /-TAIL$/);
  assert.match(output, /bytes omitted/);
  assert.doesNotMatch(output, /\uFFFD/u);
});

test("sanitizeBounded applies a total serialization budget", () => {
  const value = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [
      `${`key-${index}`.repeat(1000)}\\\"\0`,
      `${'x\\"\0'.repeat(10000)}`,
    ]),
  );
  const sanitized = sanitizeBounded(value, {
    maxBytes: 16 * 1024,
    maxStringBytes: 4096,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(sanitized), "utf8") <= 16 * 1024);
});

test("sanitizeBounded honors tiny JSON budgets", () => {
  for (let cap = 0; cap <= 32; cap += 1) {
    const sanitized = sanitizeBounded({ value: 1n }, { maxBytes: cap });
    const serialized = JSON.stringify(sanitized);
    if (serialized === undefined) {
      assert.equal(cap, 0);
    } else {
      assert.ok(Buffer.byteLength(serialized, "utf8") <= cap);
    }
  }
});

test("small UTF-8 caps never overflow or emit replacement characters", () => {
  const input = "中🙂".repeat(100);
  for (let cap = 1; cap <= 128; cap += 1) {
    const output = truncateUtf8(input, cap, {
      tailBytes: 16,
      reportOmitted: true,
    });
    assert.ok(Buffer.byteLength(output, "utf8") <= cap);
    assert.doesNotMatch(output, /\uFFFD/u);
  }
});

test("serializeBoundedActivity always returns valid bounded JSON", () => {
  const serialized = serializeBoundedActivity(
    {
      seq: 1,
      timestamp: new Date().toISOString(),
      type: "tool_end",
      toolName: "bash",
      summary: "s".repeat(100000),
      data: { output: "x".repeat(100000) },
    },
    32 * 1024,
  );
  assert.ok(Buffer.byteLength(serialized, "utf8") <= 32 * 1024);
  assert.doesNotThrow(() => JSON.parse(serialized));
});
