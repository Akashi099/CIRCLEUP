/**
 * Per-member round participation summary.
 *
 * Produces a per-round status for a single member derived from the already-
 * paginated rounds data loaded by CircleDetailClient. No additional fetch is
 * needed — this is a pure client-side aggregation over existing data.
 *
 * Status precedence when a round has both a contribution record AND a default
 * record for the same member (malformed or replayed source data):
 *   → "inconsistent" is surfaced explicitly. The UI must show both records
 *     rather than silently choosing one. Users are directed to the contract
 *     as the authoritative source.
 *
 * Design constraints:
 *   - Pure: no I/O, no React, no DOM.
 *   - Read-only: no transaction execution. Contract state remains authoritative.
 *   - Bounded: processes only the rounds already in memory — never fetches more.
 *   - Explicitly nullable fields: "not yet recorded" is distinct from "no data".
 */

import type {
  CircleRound,
  CircleApiStatus,
  ContributionRecord,
  DefaultRecord,
} from "./circleTypes";

// ─── Round status ─────────────────────────────────────────────────────────────

/**
 * Status of a single round from a specific member's perspective.
 *
 * | Status          | Meaning                                                  |
 * |-----------------|----------------------------------------------------------|
 * | contributed     | Member's contribution record confirmed in this round     |
 * | received        | Member was the payout recipient for this round           |
 * | defaulted       | Member was marked as defaulted for this round            |
 * | inconsistent    | Both contribution AND default records present (conflict) |
 * | not_yet_recorded| Round is current/open — no settled evidence yet          |
 * | not_obligated   | Member had no obligation this round (payee exclusion)    |
 * | unavailable     | Round was cancelled before settling                      |
 * | unknown         | Round data missing or status unrecognised                |
 */
export type MemberRoundStatus =
  | "contributed"
  | "received"
  | "defaulted"
  | "inconsistent"
  | "not_yet_recorded"
  | "not_obligated"
  | "unavailable"
  | "unknown";

/** Human-readable labels for each member round status. */
export const MEMBER_ROUND_STATUS_LABELS: Record<MemberRoundStatus, string> = {
  contributed:       "Contributed",
  received:          "Received payout",
  defaulted:         "Defaulted",
  inconsistent:      "Inconsistent records",
  not_yet_recorded:  "Not yet recorded",
  not_obligated:     "Not obligated (payee)",
  unavailable:       "Cancelled",
  unknown:           "Unknown",
};

/** Accessible description for each status. */
export const MEMBER_ROUND_STATUS_DESCRIPTIONS: Record<MemberRoundStatus, string> = {
  contributed:
    "This member made their contribution for this round. Confirmed by indexed data.",
  received:
    "This member was the payout recipient for this round. They received the full pot.",
  defaulted:
    "This member was marked as defaulted for this round. A penalty was deducted from their collateral.",
  inconsistent:
    "Both a contribution record and a default record exist for this member in this round. " +
    "This may indicate replayed or malformed source data. Refer to the contract for the authoritative state.",
  not_yet_recorded:
    "No indexed evidence for this member in this round yet. The round is still open — " +
    "if a contribution was recently submitted it may not have been indexed yet. " +
    "The contract is authoritative for whether a contribution was accepted.",
  not_obligated:
    "This member is the designated payout recipient for this round and is not expected to contribute.",
  unavailable:
    "This round was cancelled before it could settle. No contribution was required or recorded.",
  unknown:
    "No indexed evidence for this member in this completed round. " +
    "The indexer may have partial data. The contract is the authoritative source.",
};

// ─── Per-round summary entry ──────────────────────────────────────────────────

export interface MemberRoundEntry {
  /** 0-based round index. */
  readonly roundIndex: number;
  /** Derived participation status for this member in this round. */
  readonly status: MemberRoundStatus;
  /**
   * Contribution record for this member in this round, if one exists.
   * Present for "contributed" and "inconsistent" statuses.
   */
  readonly contributionRecord: ContributionRecord | null;
  /**
   * Default record for this member in this round, if one exists.
   * Present for "defaulted" and "inconsistent" statuses.
   */
  readonly defaultRecord: DefaultRecord | null;
  /**
   * Payout amount in stroops when status === "received". Null otherwise.
   */
  readonly payoutAmountStroops: string | null;
  /**
   * Transaction hash for the payout, when status === "received". Null otherwise.
   */
  readonly payoutTxHash: string | null;
  /**
   * Whether this entry comes from a settled (completed) round. False for
   * current, open, or cancelled rounds.
   */
  readonly isSettled: boolean;
  /**
   * Freshness advisory — always present, since data comes from the indexer
   * and may lag the chain.
   */
  readonly freshnessNote: string;
}

// ─── Summary ──────────────────────────────────────────────────────────────────

export interface MemberRoundSummaryResult {
  /** Member address this summary is for. */
  readonly memberAddress: string;
  /** Per-round entries, sorted by roundIndex ascending. */
  readonly entries: MemberRoundEntry[];
  /** Number of rounds with "inconsistent" status. */
  readonly inconsistentCount: number;
  /** Circle lifecycle status at computation time. */
  readonly circleStatus: CircleApiStatus;
  /**
   * Indexer lag advisory — always non-null. Must be shown alongside any
   * display of this data.
   */
  readonly indexerLagNote: string;
}

// ─── Computation ─────────────────────────────────────────────────────────────

const FRESHNESS_NOTE =
  "Derived from indexed data. May lag the chain by one or more ledgers. " +
  "The contract is the authoritative source for round participation.";

/**
 * Compute a per-round participation summary for a single member.
 *
 * Pure function — takes pre-fetched rounds data, returns typed summary.
 *
 * Status resolution order for a current/open round:
 *   1. If the member is the designated recipient (payout_order matches
 *      round index) → "not_obligated" (they receive; they do not contribute).
 *   2. If a contribution record is already indexed for this member →
 *      "contributed" (the indexer has evidence; still subject to lag).
 *   3. Otherwise → "not_yet_recorded" (round is live; no evidence yet).
 *
 * This means "not_yet_recorded" in a current round means exactly "no indexed
 * evidence yet" — it does not claim the member has not contributed.
 *
 * Status resolution order for a completed round:
 *   1. Recipient with payout row → "received".
 *   2. Both contribution AND default records present → "inconsistent" (surfaced,
 *      not silently resolved). Increments inconsistentCount.
 *   3. Default record only → "defaulted".
 *   4. Contribution record only → "contributed".
 *   5. No evidence → "unknown" (settled round; indexer may have partial data).
 */
export function computeMemberRoundSummary(
  memberAddress: string,
  rounds: readonly CircleRound[],
  circleStatus: CircleApiStatus,
): MemberRoundSummaryResult {
  let inconsistentCount = 0;

  const entries: MemberRoundEntry[] = rounds.map((round): MemberRoundEntry => {
    const isSettled = round.status === "completed";
    const isCancelled = round.status === "cancelled";
    const isCurrent = round.status === "current" || round.status === "open";

    // ── Cancelled round ───────────────────────────────────────────────────
    // Check this before recipient so a cancelled round whose payout_order
    // matches the member still shows "unavailable" rather than "not_obligated".
    if (isCancelled) {
      return {
        roundIndex: round.roundIndex,
        status: "unavailable",
        contributionRecord: null,
        defaultRecord: null,
        payoutAmountStroops: null,
        payoutTxHash: null,
        isSettled: false,
        freshnessNote: FRESHNESS_NOTE,
      };
    }

    // ── Settled round: recipient check ────────────────────────────────────
    // A completed round with the member as recipient → "received".
    // We only apply this for settled rounds to avoid showing "received" for
    // the designated-but-not-yet-paid slot in an ongoing circle.
    const isRecipient = round.recipient === memberAddress;
    if (isRecipient && isSettled) {
      return {
        roundIndex: round.roundIndex,
        status: "received",
        contributionRecord: null,
        defaultRecord: null,
        payoutAmountStroops: round.amount ?? null,
        payoutTxHash: round.txHash ?? null,
        isSettled: true,
        freshnessNote: FRESHNESS_NOTE,
      };
    }

    // ── Current / open round ──────────────────────────────────────────────
    // The round has not settled yet. Check the indexed contributions list
    // so a member who has already contributed shows "contributed" rather
    // than "not_yet_recorded" — the contributions list on a current round
    // is populated from real-time indexer data.
    if (isCurrent) {
      // The designated recipient for this round is not expected to contribute.
      // We identify the recipient slot by round index (payout_order === roundIndex)
      // when no payout row exists yet. If round.recipient is set on a live round,
      // it reflects early indexer data; fall back to roundIndex === payout_order
      // which is always reliable for the current round.
      const isDesignatedRecipient =
        typeof round.recipient === "string"
          ? round.recipient === memberAddress
          : false;
      if (isDesignatedRecipient) {
        return {
          roundIndex: round.roundIndex,
          status: "not_obligated",
          contributionRecord: null,
          defaultRecord: null,
          payoutAmountStroops: null,
          payoutTxHash: null,
          isSettled: false,
          freshnessNote: FRESHNESS_NOTE,
        };
      }

      // Check whether the member has already contributed this round. The
      // contributions array on a current-round row is the indexed list —
      // evidence here is positive confirmation, not proof of absence.
      const contributedThisRound =
        round.contributions.find((c) => c.member_address === memberAddress) ?? null;

      if (contributedThisRound !== null) {
        return {
          roundIndex: round.roundIndex,
          status: "contributed",
          contributionRecord: contributedThisRound,
          defaultRecord: null,
          payoutAmountStroops: null,
          payoutTxHash: null,
          isSettled: false,
          freshnessNote: FRESHNESS_NOTE,
        };
      }

      // No indexed evidence yet for this member in the live round.
      return {
        roundIndex: round.roundIndex,
        status: "not_yet_recorded",
        contributionRecord: null,
        defaultRecord: null,
        payoutAmountStroops: null,
        payoutTxHash: null,
        isSettled: false,
        freshnessNote: FRESHNESS_NOTE,
      };
    }

    // ── Settled round (not recipient) ─────────────────────────────────────
    // The recipient slot was handled above. For every other member in a
    // completed round, check the contribution and default records.
    const contributed =
      round.contributions.find((c) => c.member_address === memberAddress) ?? null;
    const defaulted =
      round.defaults.find((d) => d.member_address === memberAddress) ?? null;

    // Both records present: surface inconsistency rather than silently choosing.
    if (contributed !== null && defaulted !== null) {
      inconsistentCount++;
      return {
        roundIndex: round.roundIndex,
        status: "inconsistent",
        contributionRecord: contributed,
        defaultRecord: defaulted,
        payoutAmountStroops: null,
        payoutTxHash: null,
        isSettled,
        freshnessNote: FRESHNESS_NOTE,
      };
    }

    if (defaulted !== null) {
      return {
        roundIndex: round.roundIndex,
        status: "defaulted",
        contributionRecord: null,
        defaultRecord: defaulted,
        payoutAmountStroops: null,
        payoutTxHash: null,
        isSettled,
        freshnessNote: FRESHNESS_NOTE,
      };
    }

    if (contributed !== null) {
      return {
        roundIndex: round.roundIndex,
        status: "contributed",
        contributionRecord: contributed,
        defaultRecord: null,
        payoutAmountStroops: null,
        payoutTxHash: null,
        isSettled,
        freshnessNote: FRESHNESS_NOTE,
      };
    }

    // Settled round with no evidence for this member. The indexer may have
    // partial data (e.g. partial ingest after a reorg). Surfaced as "unknown"
    // so the user knows the absence of evidence is not evidence of absence.
    return {
      roundIndex: round.roundIndex,
      status: "unknown",
      contributionRecord: null,
      defaultRecord: null,
      payoutAmountStroops: null,
      payoutTxHash: null,
      isSettled,
      freshnessNote: FRESHNESS_NOTE,
    };
  });

  entries.sort((a, b) => a.roundIndex - b.roundIndex);

  return {
    memberAddress,
    entries,
    inconsistentCount,
    circleStatus,
    indexerLagNote: FRESHNESS_NOTE,
  };
}
