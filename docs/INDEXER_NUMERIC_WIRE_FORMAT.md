# Indexer API — Numeric Wire Format

Every numeric field in an indexer JSON response has **exactly one** JSON
representation. Clients never have to guess whether a value is stroops or
USDC, a safe integer or an encoded string.

The contract is enforced by `sdk/src/indexerSchema.ts`
(`INDEXER_RESPONSE_SCHEMAS`) and tested by
`sdk/src/__tests__/indexerContract.test.ts` and
`sdk/src/__tests__/numericWireFormat.test.ts` (zero, `2^53 − 1`, `2^53 + 1`
and `i128::MAX` fixtures). The API side lives in `indexer/src/api.ts`
(`toSafeInteger`).

See also: [`INDEXER_API_COMPATIBILITY.md`](./INDEXER_API_COMPATIBILITY.md).

## The three numeric wire types

| Wire type | JSON | Used for | Parse with |
|-----------|------|----------|------------|
| `stroops` | decimal integer **string**, may be `"0"`, never a JSON number, never a decimal point | Every base-unit token amount (Postgres `NUMERIC`). 1 USDC = 10,000,000 stroops. | `BigInt(value)`; format for display with `formatUsdc` / `stroopsToUsdc`. |
| `uint_string` | non-negative decimal integer **string** | Persisted Postgres `BIGINT` columns: row-level ledger sequences and `round_deadline_ledgers`. Returned exactly as Postgres emits them. | `BigInt(value)`, or `Number(value)` after a safe-integer check. |
| `integer` | JSON number that is a **safe integer** (`Number.isSafeInteger`) | Counts, indices, positions, page metadata, reputation scores, and ledger values the API computes or converts itself. | Use directly. The API refuses (HTTP 500) rather than round a value outside the safe range. |

There are **no display-unit decimals** in indexer responses. Display
formatting happens in the client.

Timestamps are ISO-8601 strings (`timestamp`), not numbers.

## Field inventory

`?` = optional, `| null` = nullable.

### `GET /circles`, `GET /circles/:address` (`circle`), `GET /members/:member/circles` (`circle`)

| Field | DB type | Wire |
|-------|---------|------|
| `round_amount` | NUMERIC | `stroops` |
| `member_count`, `current_round`, `total_rounds` | INTEGER | `integer` |
| `created_ledger` | BIGINT | `uint_string` |
| `round_deadline_ledgers` ? | BIGINT | `uint_string \| null` |
| `deadline_ledger` ? | computed | `integer \| null` |
| `id` ? | SERIAL | `integer` |

### Members (`GET /circles/:address`, `GET /circles/:address/members`, `GET /members/:member/circles`)

| Field | DB type | Wire |
|-------|---------|------|
| `collateral` | NUMERIC | `stroops` |
| `payout_order`, `defaults` | INTEGER | `integer` |
| `join_order` | INTEGER | `integer \| null` |
| `reputation_score` | INTEGER | `integer \| null` |
| `total_contributions` ? | COUNT | `integer` |
| `totals.memberCount`, `totals.totalContributions` | COUNT | `integer` |
| `totals.totalCollateral` | SUM(NUMERIC) | `stroops` |
| `roundDeadlineLedgers` ? | BIGINT | `uint_string \| null` |
| `latestLedger` (detail) | BIGINT → converted | `integer \| null` |

### Rounds (`GET /circles/:address/rounds`)

| Field | DB type | Wire |
|-------|---------|------|
| `roundIndex`, `contributions[].round_index`, `defaults[].round_index` | INTEGER | `integer` |
| `amount` (payout) | NUMERIC | `stroops \| null` |
| `contributions[].amount` | NUMERIC | `stroops` |
| `defaults[].penalty` | NUMERIC | `stroops` |
| `ledger`, `contributions[].ledger`, `defaults[].ledger` | BIGINT | `uint_string` (`\| null` for an unpaid round) |
| `deadlineLedger` ? | computed | `integer \| null` |

### Member contributions (`GET /members/:member/contributions`)

| Field | DB type | Wire |
|-------|---------|------|
| `contributions[].amount` | NUMERIC | `stroops` |
| `contributions[].round_index` | INTEGER | `integer` |
| `contributions[].ledger` | BIGINT | `uint_string` |
| `totalAmount` ? | SUM(NUMERIC) | `stroops` |

### Activity (`GET /circles/:address/activity`)

| Field | DB type | Wire |
|-------|---------|------|
| `amount`, `penalty` | NUMERIC | `stroops \| null` |
| `round`, `event_position` | INTEGER | `integer` |
| `ledger` | BIGINT → converted | `integer` |

### Audit (`GET /circles/:address/audit`)

| Field | DB type | Wire |
|-------|---------|------|
| `id` | SERIAL | `integer` |
| `ledger` | BIGINT | `uint_string \| null` |
| `total_released`, `total_expected_collateral` | NUMERIC | `stroops \| null` |

### Reputation (`GET /reputation/:member`)

| Field | DB type | Wire |
|-------|---------|------|
| `score` | INTEGER | `integer \| null` |
| `contributions[].contributions`, `contributions[].total_rounds`, `defaults[].count`, `events[].delta` | COUNT / INTEGER | `integer` |

### Indexer state (`GET /indexer/state`)

| Field | DB type | Wire |
|-------|---------|------|
| `lastLedger` | BIGINT → converted | `integer` |
| `totalEvents`, `eventCounts.*`, `entityCounts.*` | COUNT | `integer` |

### Pagination envelopes

| Field | Wire |
|-------|------|
| `page`, `limit`, `total`, `totalPages` | `integer` |
| `hasMore` | boolean |
| `nextCursor` | opaque string \| null (not numeric — never parse it) |

## Why two ledger forms?

Persisted `BIGINT` columns are passed through as Postgres emits them
(`uint_string`), so a row read from the database is never re-encoded.
Values the handler already converts — the indexer checkpoint (`latestLedger`,
`lastLedger`), computed deadlines and the activity feed's `ledger` — are JSON
safe integers, and `toSafeInteger` fails loudly instead of rounding. Each
field has one form, listed above; the schema rejects the other.

## Migration notes (issue #897)

Intentional wire-format corrections:

- `GET /members/:member/circles` → `circle.deadline_ledger` is now a JSON
  integer. It previously leaked the raw SQL `BIGINT` as a decimal string,
  unlike the same field on `GET /circles/:address`.
- The SDK schema type `bigint` (number *or* string) is no longer used by any
  built-in schema. Each ledger field is now `uint_string` or `integer`, so a
  value switching form is reported as drift. `bigint` remains in
  `IndexerWireType` for external schemas.
- SDK TypeScript types were narrowed to what the server actually sends:
  `ApiCircleRow.created_ledger: string` (was `number | string`),
  `round_deadline_ledgers` / `roundDeadlineLedgers: string | null`, and
  `ApiRoundRow.ledger: string | null`. Code that already handled the string
  form is unaffected.
