/**
 * check-token-assumptions.ts — Executable verification of USDC token assumptions (Issue #892 / Issue 56)
 *
 * Verifies:
 * - Address syntax and network-specific expectations (canonical mainnet SAC address).
 * - Decimal precision (must be 7 for USDC).
 * - SEP-41 token metadata (symbol == "USDC", name).
 * - Read-only simulation without submitting state-changing transactions.
 * - Categorizes results as "pass", "mismatch", "unverifiable", or "unavailable".
 * - Documents properties that cannot be read from chain (trust assertions).
 */

import { StrKey, rpc as StellarRpc, Contract, Account, TransactionBuilder, scValToNative } from "@stellar/stellar-sdk";

export type TokenCheckStatus = "pass" | "mismatch" | "unverifiable" | "unavailable";

export const CANONICAL_MAINNET_USDC_ADDRESS =
  "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
export const EXPECTED_USDC_DECIMALS = 7;
export const EXPECTED_USDC_SYMBOL = "USDC";

export interface TokenVerificationInput {
  tokenAddress?: string;
  network?: string;
  rpcUrl?: string;
  timeoutMs?: number;
  rpcClient?: {
    simulateTransaction: (tx: any) => Promise<any>;
  };
}

export interface TokenAssumptionReport {
  status: TokenCheckStatus;
  tokenAddress: string;
  network: string;
  onChainVerified: {
    addressShapeValid: boolean;
    isCanonicalMainnetAddress?: boolean;
    contractExists: boolean;
    decimalsVerified: boolean;
    observedDecimals?: number;
    symbolVerified: boolean;
    observedSymbol?: string;
  };
  trustAssertions: {
    fiatReserveBacking: "unverifiable_on_chain";
    issuerRegulatoryStanding: "unverifiable_on_chain";
    circleCustodyPolicy: "unverifiable_on_chain";
  };
  errors: string[];
  warnings: string[];
  unverifiableNotes: string[];
  summary: string;
}

/**
 * Execute a promise with a bounded timeout.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Read-only check of token contract assumptions.
 */
export async function checkTokenAssumptions(
  input: TokenVerificationInput
): Promise<TokenAssumptionReport> {
  const tokenAddress = (input.tokenAddress || "").trim();
  const network = (input.network || "testnet").trim().toLowerCase();
  const timeoutMs = input.timeoutMs ?? 5000;
  const errors: string[] = [];
  const warnings: string[] = [];
  const unverifiableNotes: string[] = [
    "1:1 off-chain fiat reserve backing cannot be verified on-chain; requires operator attestation.",
    "Issuer key authority (Circle Centre) is an operational trust assertion.",
  ];

  const onChainVerified = {
    addressShapeValid: false,
    isCanonicalMainnetAddress: undefined as boolean | undefined,
    contractExists: false,
    decimalsVerified: false,
    observedDecimals: undefined as number | undefined,
    symbolVerified: false,
    observedSymbol: undefined as string | undefined,
  };

  const trustAssertions = {
    fiatReserveBacking: "unverifiable_on_chain" as const,
    issuerRegulatoryStanding: "unverifiable_on_chain" as const,
    circleCustodyPolicy: "unverifiable_on_chain" as const,
  };

  if (!tokenAddress) {
    return {
      status: "unavailable",
      tokenAddress: "",
      network,
      onChainVerified,
      trustAssertions,
      errors: ["Token address is not configured."],
      warnings,
      unverifiableNotes,
      summary: "Token check failed: No token address provided.",
    };
  }

  // 1. Verify address shape (Never label address correct based ONLY on string shape)
  if (!StrKey.isValidContract(tokenAddress)) {
    return {
      status: "mismatch",
      tokenAddress,
      network,
      onChainVerified,
      trustAssertions,
      errors: [`Token address "${tokenAddress}" is not a valid Stellar contract ID (expected C...).`],
      warnings,
      unverifiableNotes,
      summary: `Token check mismatch: Invalid address format for "${tokenAddress}".`,
    };
  }
  onChainVerified.addressShapeValid = true;

  // 2. Mainnet canonical SAC address check
  if (network === "mainnet") {
    const isCanonical = tokenAddress === CANONICAL_MAINNET_USDC_ADDRESS;
    onChainVerified.isCanonicalMainnetAddress = isCanonical;
    if (!isCanonical) {
      errors.push(
        `Mainnet USDC address mismatch: configured "${tokenAddress}", but canonical Mainnet USDC SAC address is "${CANONICAL_MAINNET_USDC_ADDRESS}".`
      );
    }
  }

  // 3. Live on-chain simulation checks if RPC client or URL is provided
  if (!input.rpcClient && !input.rpcUrl) {
    // Cannot perform read-only on-chain verification without RPC
    const isMainnetMismatch = errors.length > 0;
    const status: TokenCheckStatus = isMainnetMismatch ? "mismatch" : "unverifiable";
    unverifiableNotes.push("Live RPC endpoint not provided; on-chain metadata could not be inspected.");
    return {
      status,
      tokenAddress,
      network,
      onChainVerified,
      trustAssertions,
      errors,
      warnings,
      unverifiableNotes,
      summary: isMainnetMismatch
        ? `Token check mismatch: Address does not match canonical mainnet USDC.`
        : `Token check unverifiable: Address shape valid, but live RPC verification skipped.`,
    };
  }

  try {
    const rpcServer =
      input.rpcClient ??
      new StellarRpc.Server(input.rpcUrl!, {
        allowHttp: input.rpcUrl!.startsWith("http://"),
      });

    // Dummy account for read-only simulation
    const dummySource = new Account("GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H", "0");
    const contract = new Contract(tokenAddress);

    // Read decimals()
    const decimalsTx = new TransactionBuilder(dummySource, {
      fee: "100",
      networkPassphrase: network === "mainnet" ? "Public Global Stellar Network ; September 2015" : "Test SDF Network ; September 2015",
    })
      .addOperation(contract.call("decimals"))
      .setTimeout(30)
      .build();

    const decimalsSim = await withTimeout(
      rpcServer.simulateTransaction(decimalsTx),
      timeoutMs,
      `Simulate decimals() on ${tokenAddress}`
    );

    if (decimalsSim.error || !decimalsSim.result?.retval) {
      // Contract call failed or method not found
      if (errors.length > 0) {
        return {
          status: "mismatch",
          tokenAddress,
          network,
          onChainVerified,
          trustAssertions,
          errors,
          warnings,
          unverifiableNotes,
          summary: `Token check mismatch: Mainnet canonical address check failed.`,
        };
      }
      return {
        status: "unverifiable",
        tokenAddress,
        network,
        onChainVerified,
        trustAssertions,
        errors,
        warnings,
        unverifiableNotes: [
          ...unverifiableNotes,
          `Contract simulation returned error: ${decimalsSim.error ?? "no return value"}. Token may not implement SEP-41 decimals().`,
        ],
        summary: `Token check unverifiable: Token at ${tokenAddress} did not return valid SEP-41 decimals.`,
      };
    }

    onChainVerified.contractExists = true;
    const decimalsValue = scValToNative(decimalsSim.result.retval);
    onChainVerified.observedDecimals = Number(decimalsValue);

    if (onChainVerified.observedDecimals !== EXPECTED_USDC_DECIMALS) {
      errors.push(
        `Token decimal precision mismatch: expected ${EXPECTED_USDC_DECIMALS}, got ${onChainVerified.observedDecimals}.`
      );
    } else {
      onChainVerified.decimalsVerified = true;
    }

    // Read symbol()
    try {
      const symbolTx = new TransactionBuilder(dummySource, {
        fee: "100",
        networkPassphrase: network === "mainnet" ? "Public Global Stellar Network ; September 2015" : "Test SDF Network ; September 2015",
      })
        .addOperation(contract.call("symbol"))
        .setTimeout(30)
        .build();

      const symbolSim = await withTimeout(
        rpcServer.simulateTransaction(symbolTx),
        timeoutMs,
        `Simulate symbol() on ${tokenAddress}`
      );

      if (symbolSim.result?.retval) {
        const symbolVal = scValToNative(symbolSim.result.retval);
        onChainVerified.observedSymbol = String(symbolVal);
        if (onChainVerified.observedSymbol === EXPECTED_USDC_SYMBOL) {
          onChainVerified.symbolVerified = true;
        } else {
          warnings.push(
            `Token symbol "${onChainVerified.observedSymbol}" differs from standard "${EXPECTED_USDC_SYMBOL}".`
          );
        }
      }
    } catch {
      // Non-fatal if symbol() fails, decimals is primary
      unverifiableNotes.push("symbol() view call did not succeed.");
    }
  } catch (err: any) {
    const status: TokenCheckStatus = errors.length > 0 ? "mismatch" : "unavailable";
    return {
      status,
      tokenAddress,
      network,
      onChainVerified,
      trustAssertions,
      errors: [...errors, `RPC communication failed: ${err.message}`],
      warnings,
      unverifiableNotes,
      summary:
        status === "mismatch"
          ? `Token check mismatch: ${errors.join("; ")}.`
          : `Token check unavailable: Could not reach live RPC for ${tokenAddress} (${err.message}).`,
    };
  }

  const hasMismatch = errors.length > 0;
  const status: TokenCheckStatus = hasMismatch
    ? "mismatch"
    : onChainVerified.decimalsVerified
      ? "pass"
      : "unverifiable";

  const summary =
    status === "pass"
      ? `Token verification PASSED for ${tokenAddress} on ${network} (7 decimals confirmed).`
      : status === "mismatch"
        ? `Token verification MISMATCH for ${tokenAddress} (${errors.join("; ")}).`
        : `Token verification UNVERIFIABLE for ${tokenAddress}.`;

  return {
    status,
    tokenAddress,
    network,
    onChainVerified,
    trustAssertions,
    errors,
    warnings,
    unverifiableNotes,
    summary,
  };
}

// ── CLI Runner ────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  const address = getArg("--address") ?? process.env.USDC_ADDRESS;
  const network = getArg("--network") ?? process.env.NETWORK ?? "testnet";
  const rpcUrl = getArg("--rpc") ?? process.env.STELLAR_RPC_URL;
  const jsonArg = args.includes("--json");

  checkTokenAssumptions({
    tokenAddress: address,
    network,
    rpcUrl,
  })
    .then((report) => {
      if (jsonArg) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log("\n========================================================");
        console.log("             USDC TOKEN ASSUMPTION CHECK                ");
        console.log("========================================================\n");
        console.log(`[Status]       : ${report.status.toUpperCase()}`);
        console.log(`[Token Address]: ${report.tokenAddress}`);
        console.log(`[Network]      : ${report.network}`);
        console.log(`[Decimals]     : ${report.onChainVerified.observedDecimals ?? "not verified"}`);
        console.log(`[Symbol]       : ${report.onChainVerified.observedSymbol ?? "not verified"}`);
        console.log("\n--------------------------------------------------------");
        if (report.errors.length > 0) {
          console.log("ERRORS:");
          report.errors.forEach((e) => console.log(`  ❌ ${e}`));
        }
        if (report.warnings.length > 0) {
          console.log("WARNINGS:");
          report.warnings.forEach((w) => console.log(`  ⚠ ${w}`));
        }
        console.log("TRUST ASSERTIONS (UNVERIFIABLE ON-CHAIN):");
        report.unverifiableNotes.forEach((n) => console.log(`  ℹ ${n}`));
        console.log(`\nSUMMARY: ${report.summary}\n`);
      }
      process.exit(report.status === "pass" ? 0 : 1);
    })
    .catch((err) => {
      console.error("Fatal token check error:", err);
      process.exit(1);
    });
}
