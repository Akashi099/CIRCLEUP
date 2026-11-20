/**
 * Issue #898: opaque keyset cursor encoding and validation.
 *
 * Endpoint-level behaviour (first / middle / final pages against a real
 * database) is exercised by the SDK cursor tests and the DB suite; these
 * tests pin down the token rules that keep cursors opaque and bound to the
 * query they were issued for.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HISTORY_CURSOR_VERSION,
  INVALID_CURSOR_ERROR,
  MAX_CURSOR_LENGTH,
  encodeHistoryCursor,
  parseHistoryCursor,
} from "./historyCursor";

const CIRCLE = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const OTHER = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const MEMBER_FILTER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF|";

const raw = (payload: unknown) => Buffer.from(JSON.stringify(payload)).toString("base64url");

test("#898 no cursor parameter selects page mode", () => {
  assert.deepEqual(parseHistoryCursor(undefined, "activity", CIRCLE), { mode: "page" });
});

test("#898 an empty cursor starts a keyset scan from the first row", () => {
  assert.deepEqual(parseHistoryCursor("", "activity", CIRCLE), { mode: "cursor", after: null });
});

test("#898 a cursor round-trips the last row's key exactly", () => {
  const token = encodeHistoryCursor("activity", CIRCLE, ["9007199254740993", 2, 41]);
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(parseHistoryCursor(token, "activity", CIRCLE), {
    mode: "cursor",
    after: ["9007199254740993", "2", "41"],
  });
});

test("#898 contribution cursors carry a microsecond timestamp tie-breaker", () => {
  const key = ["1240000", 3, "2026-01-02 00:00:00.123456+00", 17];
  const token = encodeHistoryCursor("contributions", MEMBER_FILTER, key);
  assert.deepEqual(parseHistoryCursor(token, "contributions", MEMBER_FILTER), {
    mode: "cursor",
    after: key.map(String),
  });
});

test("#898 a token never exposes column names or SQL", () => {
  const token = encodeHistoryCursor("activity", CIRCLE, ["1", 0, 1]);
  const decoded = Buffer.from(token, "base64url").toString("utf8");
  assert.doesNotMatch(decoded, /ledger|event_position|sort_id|SELECT|WHERE/i);
});

test("#898 a cursor issued for another circle or endpoint is rejected", () => {
  const token = encodeHistoryCursor("activity", CIRCLE, ["1", 0, 1]);
  assert.deepEqual(parseHistoryCursor(token, "activity", OTHER), { error: INVALID_CURSOR_ERROR });
  assert.deepEqual(parseHistoryCursor(token, "contributions", CIRCLE), { error: INVALID_CURSOR_ERROR });
});

test("#898 malformed, oversized, or wrong-version cursors are rejected", () => {
  const cases: unknown[] = [
    "not base64url!",
    raw("just a string"),
    raw([1, 2, 3]),
    "x".repeat(MAX_CURSOR_LENGTH + 1),
    raw({ v: HISTORY_CURSOR_VERSION + 1, s: "activity", f: CIRCLE, k: ["1", "0", "1"] }),
    raw({ v: HISTORY_CURSOR_VERSION, s: "activity", f: CIRCLE, k: ["1", "0"] }),
    raw({ v: HISTORY_CURSOR_VERSION, s: "activity", f: CIRCLE, k: ["-1", "0", "1"] }),
    raw({ v: HISTORY_CURSOR_VERSION, s: "activity", f: CIRCLE, k: ["1", "0", "1; DROP TABLE"] }),
    raw({ v: HISTORY_CURSOR_VERSION, s: "activity", f: CIRCLE, k: ["99999999999999999999", "0", "1"] }),
  ];
  for (const value of cases) {
    const result = parseHistoryCursor(value, "activity", CIRCLE);
    assert.ok("error" in result, `expected ${String(value).slice(0, 40)} to be rejected`);
  }
  const badTimestamp = raw({ v: HISTORY_CURSOR_VERSION, s: "contributions", f: MEMBER_FILTER, k: ["1", "0", "yesterday", "1"] });
  assert.ok("error" in parseHistoryCursor(badTimestamp, "contributions", MEMBER_FILTER));
  assert.deepEqual(parseHistoryCursor(["a", "b"], "activity", CIRCLE), {
    error: "cursor must be a single string value",
  });
});
