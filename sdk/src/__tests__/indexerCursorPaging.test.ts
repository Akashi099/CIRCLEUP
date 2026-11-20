/**
 * Issue #898: cursor (keyset) pagination for large history scans.
 *
 * The stub server below pages an append-only activity log the way
 * GET /circles/:address/activity?cursor= does — strictly after the last key
 * of the previous page — so the tests can insert rows between page fetches
 * and check that no row is duplicated or skipped. Covered: first, middle and
 * final pages; invalid and stale cursors; local validation; and that the
 * page-based methods keep their behaviour.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexerClient, IndexerError } from "../client";
import type { CircleUpConfig } from "../types";
import { CIRCLE_ADDR, MEMBER_A_ADDR, SDK_CONFIG } from "./fixtures";

const CONFIG: CircleUpConfig = { ...SDK_CONFIG, indexerUrl: "http://localhost:3001" };
const indexer = () => new IndexerClient(CONFIG);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

const encode = (id: number) => Buffer.from(JSON.stringify({ v: 1, after: id })).toString("base64url");
const decode = (token: string) => JSON.parse(Buffer.from(token, "base64url").toString()).after as number;

/** Append-only event log keyed by a unique, increasing id. */
function activityServer(initial: number) {
  const ids = Array.from({ length: initial }, (_, i) => i + 1);
  const urls: URL[] = [];
  const fetchMock = vi.fn(async (raw: string) => {
    const url = new URL(raw);
    urls.push(url);
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const cursor = url.searchParams.get("cursor");
    if (cursor === null) throw new Error("cursor parameter missing");
    let after = 0;
    if (cursor !== "") {
      try {
        after = decode(cursor);
      } catch {
        return jsonResponse({ error: "cursor is invalid" }, 400);
      }
    }
    const rows = ids.filter((id) => id > after);
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    return jsonResponse({
      circle_address: CIRCLE_ADDR,
      events: page.map((id) => ({ id: String(id), ledger: id })),
      pagination: { limit, hasMore, nextCursor: hasMore ? encode(page[page.length - 1]) : null },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { urls, insert: (id: number) => ids.push(id) };
}

describe("getCircleActivityByCursor", () => {
  it("starts a scan with an empty cursor parameter (first page)", async () => {
    const server = activityServer(5);
    const page = await indexer().getCircleActivityByCursor(CIRCLE_ADDR, { limit: 2 });
    expect(server.urls[0].searchParams.get("cursor")).toBe("");
    expect(server.urls[0].searchParams.has("page")).toBe(false);
    expect(page.events.map((e) => e.id)).toEqual(["1", "2"]);
    expect(page.pagination.hasMore).toBe(true);
    expect(page.pagination.nextCursor).toEqual(expect.any(String));
  });

  it("continues from a middle page and ends with a null cursor (final page)", async () => {
    activityServer(5);
    const client = indexer();
    const first = await client.getCircleActivityByCursor(CIRCLE_ADDR, { limit: 2 });
    const middle = await client.getCircleActivityByCursor(CIRCLE_ADDR, {
      limit: 2,
      cursor: first.pagination.nextCursor,
    });
    const last = await client.getCircleActivityByCursor(CIRCLE_ADDR, {
      limit: 2,
      cursor: middle.pagination.nextCursor,
    });
    expect(middle.events.map((e) => e.id)).toEqual(["3", "4"]);
    expect(last.events.map((e) => e.id)).toEqual(["5"]);
    expect(last.pagination).toEqual({ limit: 2, hasMore: false, nextCursor: null });
  });

  it("neither duplicates nor skips rows inserted between page fetches", async () => {
    const server = activityServer(4);
    const seen: string[] = [];
    let inserted = false;
    for await (const page of indexer().iterateCircleActivityByCursor(CIRCLE_ADDR, { limit: 2 })) {
      seen.push(...page.events.map((e) => e.id));
      if (!inserted) {
        server.insert(5);
        server.insert(6);
        inserted = true;
      }
    }
    expect(seen).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("surfaces an indexer-rejected (invalid or stale) cursor as an HTTP 400 IndexerError", async () => {
    activityServer(3);
    const err = await indexer()
      .getCircleActivityByCursor(CIRCLE_ADDR, { cursor: "bm90LWpzb24" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IndexerError);
    expect(err).toMatchObject({ status: 400, kind: "http", retryable: false });
  });

  it("rejects a value that cannot be a cursor before any request", async () => {
    const server = activityServer(1);
    await expect(
      indexer().getCircleActivityByCursor(CIRCLE_ADDR, { cursor: "has spaces/and+slashes" }),
    ).rejects.toThrow(RangeError);
    await expect(
      indexer().getCircleActivityByCursor(CIRCLE_ADDR, { page: 2 } as never),
    ).rejects.toThrow(/unknown option "page"/);
    expect(server.urls).toHaveLength(0);
  });

  it("rejects an envelope whose hasMore and nextCursor disagree", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ events: [], pagination: { limit: 20, hasMore: true, nextCursor: null } }),
      ),
    );
    await expect(indexer().getCircleActivityByCursor(CIRCLE_ADDR)).rejects.toMatchObject({
      kind: "schema",
    });
  });

  it("stops instead of looping when the server repeats a cursor", async () => {
    const token = encode(1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ events: [{ id: "1" }], pagination: { limit: 1, hasMore: true, nextCursor: token } }),
      ),
    );
    const pages: unknown[] = [];
    const run = async () => {
      for await (const page of indexer().iterateCircleActivityByCursor(CIRCLE_ADDR, { limit: 1 })) {
        pages.push(page);
      }
    };
    await expect(run()).rejects.toMatchObject({ kind: "schema" });
    expect(pages).toHaveLength(2);
  });
});

describe("getMemberContributionsByCursor", () => {
  it("sends circle, cursor and limit, and keeps totalAmount", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        member: MEMBER_A_ADDR,
        circle: CIRCLE_ADDR,
        contributions: [],
        totalAmount: "9007199254740993",
        pagination: { limit: 5, hasMore: false, nextCursor: null },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await indexer().getMemberContributionsByCursor(MEMBER_A_ADDR, {
      circle: CIRCLE_ADDR,
      limit: 5,
      cursor: "abc_DEF-1",
    });
    const url = new URL(fetchMock.mock.calls[0][0] as unknown as string);
    expect(url.pathname).toBe(`/members/${MEMBER_A_ADDR}/contributions`);
    expect(url.searchParams.get("cursor")).toBe("abc_DEF-1");
    expect(url.searchParams.get("circle")).toBe(CIRCLE_ADDR);
    expect(url.searchParams.get("limit")).toBe("5");
    expect(res.totalAmount).toBe("9007199254740993");
  });
});

describe("page-based methods are unchanged", () => {
  it("getMemberContributions still sends page/limit and no cursor", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        member: MEMBER_A_ADDR,
        circle: null,
        contributions: [],
        totalAmount: "0",
        pagination: { page: 2, limit: 20, total: 0, totalPages: 0, hasMore: false, nextCursor: null },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await indexer().getMemberContributions(MEMBER_A_ADDR, { page: 2 });
    const url = new URL(fetchMock.mock.calls[0][0] as unknown as string);
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.has("cursor")).toBe(false);
  });
});
