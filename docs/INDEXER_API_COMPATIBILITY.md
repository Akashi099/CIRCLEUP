# CircleUp — Indexer API Compatibility Policy

The indexer REST API is consumed by the SDK (`IndexerClient`) and the app. A
response can drift — a field renamed, a value becoming `null`, a number turning
into a string — and still come back as HTTP 200. This document defines which
response changes are safe and which need a coordinated release, and how the
fixtures catch drift before it ships.

See also: [`DEPRECATION_POLICY.md`](./DEPRECATION_POLICY.md) for notice
periods, [`CONTRACT_FIXTURES.md`](./CONTRACT_FIXTURES.md) for the equivalent
contract-argument fixtures.

---

## Where the contract lives

| File | Role |
|------|------|
| `sdk/src/indexerSchema.ts` | Runtime schemas (`INDEXER_RESPONSE_SCHEMAS`) — required fields, nullability, and wire types per endpoint. Exported with `validateIndexerResponse` and `listUnknownFields`. |
| `sdk/src/__tests__/indexerResponseFixtures.ts` | One representative body per endpoint, matching what `indexer/src/api.ts` serialises. |
| `sdk/src/__tests__/indexerContract.test.ts` | Validates every fixture against its schema and pins down the compatible vs. breaking cases below. |
| `sdk/src/client.ts` (`IndexerClient`) | Checks each response's top-level envelope at runtime and throws `IndexerError` with `kind: "schema"` on a mismatch. |

Covered endpoints: `GET /circles` (list), `GET /circles/:address` (detail),
`GET /circles/:address/members`, `GET /circles/:address/rounds`,
`GET /members/:member/contributions` (history), `GET /reputation/:member`,
`GET /circles/:address/audit`, `GET /health`, `GET /indexer/state`.

Not covered (operator/download endpoints, documented in their modules):
`GET /circles/:address/export.csv` (column contract in `indexer/src/csvExport.ts`
— columns are only ever appended) and `GET /circles/:address/reconciliation`
(diagnostic report shape in `indexer/src/circleReconciliation.ts`).

## Wire types

The TypeScript interfaces in `sdk/src/types.ts` describe *meaning*; the
schemas describe the *wire*. They differ where Postgres serialisation does:

| Wire type | Used for | Accepted JSON |
|-----------|----------|---------------|
| `stroops` | Monetary amounts (NUMERIC) | Decimal integer **string** only. A JSON number is a breaking change — it loses precision above 2^53. |
| `uint_string` | Persisted BIGINT columns — row-level ledger sequences, `round_deadline_ledgers` | Non-negative decimal integer **string** only. |
| `integer` | Counts, indices, order positions, page metadata, and ledgers the API computes or converts (`latestLedger`, `lastLedger`, `deadline_ledger`, `deadlineLedger`, activity `ledger`) | JSON number (safe integer). The API converts with `toSafeInteger`, which fails rather than rounds. |
| `bigint` | *Legacy* — no built-in schema uses it since issue #897 | Number *or* decimal string. Kept only so external schemas keep compiling. |
| `timestamp` | TIMESTAMPTZ columns | ISO-8601 string. |
| `record` | `eventCounts`, `circlesByStatus` | Object whose keys are data, not contract. |

The per-field inventory (which field uses which type, and why) is in
[`INDEXER_NUMERIC_WIRE_FORMAT.md`](./INDEXER_NUMERIC_WIRE_FORMAT.md).

## Cursor pagination (issue #898)

`GET /circles/:address/activity` and `GET /members/:member/contributions`
accept `?cursor=` alongside the existing `?page=` (which keeps its
behaviour; there is no deprecation yet). Cursor mode continues strictly after
the last row of the previous page using the endpoint's full, unique sort key,
so it neither rescans earlier rows nor shifts when rows are inserted.

| Endpoint | Order (= keyset) | Tie-breaker |
|----------|------------------|-------------|
| `/circles/:address/activity` | `ledger ASC, event_position ASC, id ASC` | `event_position` identifies the source table and `id` is that table's serial id |
| `/members/:member/contributions` | `ledger DESC, round_index DESC, created_at DESC, id DESC` | contributions `id` |

- `?cursor=` (empty) starts a scan; `?cursor=<nextCursor>` continues it.
  `cursor` cannot be combined with `page`.
- A cursor page's envelope is `{ limit, hasMore, nextCursor }`. It skips
  `COUNT(*)`, so there is no `total`. Page-mode envelopes also carry
  `nextCursor`, so a client can read page 1 and continue by cursor.
- Tokens are opaque (versioned base64url JSON with no column names or SQL),
  and each is bound to its endpoint and filters. A malformed token, a token
  from another format version, or one issued for a different circle, member
  or `circle` filter is rejected with HTTP 400. Restart the scan without a
  cursor when that happens. A token whose row has since been removed (for
  example by a replay) is still a valid position.
- **Mutation model:** history rows are append-only, and new events arrive at
  or above the indexer checkpoint. Every row that existed when a scan started
  is returned exactly once. Activity rows inserted mid-scan sort after the
  cursor and show up on later pages. Contribution rows inserted mid-scan are
  newer than the cursor, so they show up on the next new scan. A backfill
  that inserts rows below an ascending cursor is outside this model.
- SDK: `IndexerClient.getMemberContributionsByCursor`,
  `iterateMemberContributionsByCursor`, `getCircleActivityByCursor` and
  `iterateCircleActivityByCursor`. Implementation:
  `indexer/src/historyCursor.ts`.

## Compatible changes (no coordinated release)

These may ship in the indexer alone. Clients ignore what they do not read.

- Adding a new response field, at any depth.
- Adding a new key inside a `record`-typed map.
- Making a previously `nullable` field always non-null.
- Adding a new endpoint.

When adding a field, add it to the schema and the fixture in the same PR —
the fixture test fails on undocumented fields (`listUnknownFields`), so the
schema stays a complete description of what clients may rely on. Fields
that are new should be `optional` in the schema until every supported
indexer deployment returns them.

## Breaking changes (coordinated release required)

Each of these fails `indexerContract.test.ts` on purpose:

- Removing or renaming a required field.
- Making a non-nullable field nullable, or omitting a required field.
- Changing a field's wire type — e.g. an amount from string to number, or a
  count from number to string.
- Adding a value to a closed enum (`status`, round `status`, audit
  `event_type`) — clients that switch over the enum would mis-handle it.
- Changing the top-level envelope (e.g. returning a bare array).

To ship one:

1. Follow [`DEPRECATION_POLICY.md`](./DEPRECATION_POLICY.md): where possible,
   add the new shape alongside the old one first (a compatible change), and
   remove the old one after the notice period.
2. Update the schema, fixture, and the TypeScript interface together.
3. Release the SDK and app versions that accept the new shape **before or
   together with** the indexer release; record the change under
   `### Changed` / `### Removed` in `CHANGELOG.md` with the minimum compatible
   SDK version.

## Runtime behaviour

`IndexerClient` validates only the envelope at runtime (the top-level
collections each method returns), so additive changes never break callers and
deep validation cost is not paid on every request. Applications that want
full validation — for example, a diagnostics page — can call
`validateIndexerResponse(endpoint, body)` themselves. Violations report paths
and types only, never response values, so they are safe to log.
