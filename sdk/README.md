# CircleUp SDK HTTP reads

See the [versioned HTTP reference](../docs/api/README.md) and [OpenAPI v1.0.0](../docs/api/v1/openapi.json). The indexer serves the same JSON at /openapi/v1.json.

IndexerClient.getCircleHistory(address, {page, limit}, requestOptions) returns one bounded flat event page. getMemberContributions also retains its pagination metadata. getCircleAuditEvents accepts page/limit in its options; getReputation accepts page/limit/circle with read request options. Check pagination.hasMore and totalPages before treating a page as complete history. getRounds is a bounded grouped convenience view and returns HTTP 413 when too large; use getCircleHistory to retrieve every stored record. Records are not pruned.

Read options accept a random UUIDv4 requestId and onRequestId callback. Omit requestId to generate a fresh ID where Web Crypto is available, or have the server supply it. onRequestId receives a sanitized response ID even for an HTTP failure. IDs are diagnostic only and must never include a wallet identity.

Amounts are decimal stroop strings. Persisted ledger columns are decimal strings, and computed ledgers and counters are safe JSON integers. Each field has exactly one form, listed in [INDEXER_NUMERIC_WIRE_FORMAT.md](../docs/INDEXER_NUMERIC_WIRE_FORMAT.md). Member reputation and join metadata can be null; detail rows may omit contribution totals.

## Cursor pagination

For deep histories, use getMemberContributionsByCursor(member, {circle, cursor, limit}) and getCircleActivityByCursor(address, {cursor, limit}), or their iterate…ByCursor walkers. Omit cursor to start, then pass the previous page's pagination.nextCursor; null marks the final page. Cursor pages never shift when rows are indexed between requests. They carry {limit, hasMore, nextCursor} and no total. An indexer HTTP 400 means the cursor is invalid or was issued for another query; restart without one. The page-based methods are unchanged.

## Read timeouts and cancellation

Every RPC-backed read (getConfig, getStatus, getCurrentRound, getCollateral, getDefaults, hasContributed, getFullState, getScore, the factory reads and lookupTransaction) accepts ReadOptions {timeoutMs, signal}. One deadline covers every retry. The default is DEFAULT_RPC_READ_TIMEOUT_MS (20 s); change it per client with setReadTimeout(ms). A read stopped by its deadline or by the caller throws RpcReadCancelledError, whose reason is "timeout" or "aborted". The …Result variants and lookupTransaction return {ok: false, cancelled} instead, so a local stop is never confused with a remote error. The Soroban RPC transport cannot abort a request in flight: the SDK stops waiting and ignores the late response. Stopping a lookupTransaction never means the transaction was cancelled, so look it up again. Writes are unaffected: confirmation polling is bounded by PollConfig. IndexerClient reads already take timeoutMs and signal through their request options.

## Wallet adapters

WalletAdapter is an optional, server-safe interface over a wallet provider, covering capabilities, getAddress, getNetwork, signTransaction and watchChanges. signWithWalletAdapter(adapter, xdr, {networkPassphrase, accountToSign}) checks the signing capability, the active account and the network before any prompt. It returns an explicit WalletFailure (not_available, unsupported_capability, account_mismatch, network_mismatch, user_rejected, provider_error) instead of throwing. It never submits; simulate, send and poll stay with the caller. The app's Freighter implementation is app/src/lib/walletAdapter.ts.
