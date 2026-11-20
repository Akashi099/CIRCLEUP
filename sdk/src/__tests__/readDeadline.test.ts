/**
 * Issue #899: explicit timeouts and cancellation for SDK RPC reads.
 *
 * Covered: deadline expiry, caller abort (before and during a read), late
 * responses being ignored, no retries after a stop, timer and listener
 * cleanup, and that a stop is distinguishable from a remote error — including
 * for a post-submission status lookup, which must never imply the
 * transaction itself was cancelled.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { CircleClient } from "../client";
import {
  RpcReadCancelledError,
  isRpcReadCancelled,
  isTransientRpcError,
  withRpcReadDeadline,
} from "../rpcRetry";
import { CIRCLE_ADDR, SDK_CONFIG } from "./fixtures";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A promise that never settles on its own, plus a way to settle it later. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("withRpcReadDeadline", () => {
  it("rejects with reason 'timeout' once the deadline passes", async () => {
    vi.useFakeTimers();
    const call = deferred<string>();
    const read = withRpcReadDeadline("op", () => call.promise, { timeoutMs: 1_000 });
    const outcome = read.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    const err = await outcome;
    expect(err).toBeInstanceOf(RpcReadCancelledError);
    expect(err).toMatchObject({ reason: "timeout", operation: "op" });
    expect((err as Error).message).toContain("1000 ms");
  });

  it("rejects with reason 'aborted' when the caller aborts mid-read", async () => {
    const controller = new AbortController();
    const call = deferred<string>();
    const read = withRpcReadDeadline("op", () => call.promise, {
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(read).rejects.toMatchObject({ reason: "aborted" });
  });

  it("never calls the RPC when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn(async () => "value");
    await expect(
      withRpcReadDeadline("op", fn, { timeoutMs: 1_000, signal: controller.signal }),
    ).rejects.toMatchObject({ reason: "aborted" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("ignores a response that arrives after the deadline", async () => {
    vi.useFakeTimers();
    const call = deferred<string>();
    const read = withRpcReadDeadline("op", () => call.promise, { timeoutMs: 10 });
    const outcome = read.then(
      (v) => ({ value: v }),
      (e: unknown) => ({ error: e }),
    );
    await vi.advanceTimersByTimeAsync(10);
    call.resolve("late");
    expect(await outcome).toEqual({ error: expect.any(RpcReadCancelledError) });
  });

  it("does not start another attempt after an abort during backoff", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.99); // a non-zero backoff delay
    const controller = new AbortController();
    const fn = vi.fn(async () => {
      throw new Error("503 service unavailable");
    });
    const read = withRpcReadDeadline("op", fn, { timeoutMs: 60_000, signal: controller.signal }, 3, 10_000);
    const outcome = read.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);
    controller.abort();
    expect(await outcome).toMatchObject({ reason: "aborted" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("still surfaces a remote error unchanged", async () => {
    const remote = new Error("HostError: contract panicked");
    await expect(
      withRpcReadDeadline("op", async () => { throw remote; }, { timeoutMs: 1_000 }),
    ).rejects.toBe(remote);
  });

  it("removes its timer and abort listener once settled", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await expect(
      withRpcReadDeadline("op", async () => "ok", { timeoutMs: 5_000, signal: controller.signal }),
    ).resolves.toBe("ok");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an invalid timeout before calling the RPC", async () => {
    const fn = vi.fn(async () => "value");
    await expect(withRpcReadDeadline("op", fn, { timeoutMs: 0 })).rejects.toThrow(RangeError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("is never treated as a transient, retryable RPC error", () => {
    const err = new RpcReadCancelledError("op", "timeout", 5);
    expect(isTransientRpcError(err)).toBe(false);
    expect(isRpcReadCancelled(err)).toBe(true);
    expect(isRpcReadCancelled(new Error("timeout"))).toBe(false);
  });
});

describe("CircleClient reads", () => {
  function clientWithRpc(rpc: Record<string, unknown>) {
    const client = new CircleClient(SDK_CONFIG, CIRCLE_ADDR, 0);
    (client as unknown as { rpc: unknown }).rpc = rpc;
    return client;
  }

  it("getConfig throws RpcReadCancelledError (not a contract error) on abort", async () => {
    const pending = deferred<never>();
    const client = clientWithRpc({ simulateTransaction: () => pending.promise });
    const controller = new AbortController();
    const read = client.getConfig({ signal: controller.signal });
    controller.abort();
    await expect(read).rejects.toBeInstanceOf(RpcReadCancelledError);
  });

  it("getConfigResult reports cancelled: 'timeout' instead of a remote error", async () => {
    vi.useFakeTimers();
    const client = clientWithRpc({ simulateTransaction: () => deferred<never>().promise });
    const result = client.getConfigResult({ timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toMatchObject({ ok: false, cancelled: "timeout" });
  });

  it("applies the client-wide default from setReadTimeout", async () => {
    vi.useFakeTimers();
    const client = clientWithRpc({ simulateTransaction: () => deferred<never>().promise }).setReadTimeout(25);
    const result = client.getStatusResult();
    await vi.advanceTimersByTimeAsync(25);
    expect(await result).toMatchObject({ ok: false, cancelled: "timeout" });
    expect(() => client.setReadTimeout(-1)).toThrow(RangeError);
  });

  it("getFullState rethrows a cancellation instead of caching a partial state", async () => {
    const client = clientWithRpc({ simulateTransaction: () => deferred<never>().promise });
    const controller = new AbortController();
    const read = client.getFullState({ forceRefresh: true, signal: controller.signal });
    controller.abort();
    await expect(read).rejects.toBeInstanceOf(RpcReadCancelledError);
    expect(client.getCachedState()).toBeNull();
  });

  it("an aborted status lookup never claims the transaction was cancelled", async () => {
    const client = clientWithRpc({ getTransaction: () => deferred<never>().promise });
    const controller = new AbortController();
    const lookup = client.lookupTransaction("ab".repeat(32), { signal: controller.signal });
    controller.abort();
    const result = await lookup;
    expect(result).toMatchObject({ ok: false, cancelled: "aborted" });
    if (!result.ok) {
      expect(result.error).toContain("does not cancel the transaction");
      expect(result.error).toContain("may still be applied");
    }
  });

  it("a remote lookup failure carries no cancelled flag", async () => {
    const client = clientWithRpc({
      getTransaction: async () => {
        throw new Error("invalid request");
      },
    });
    const result = await client.lookupTransaction("ab".repeat(32));
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("cancelled");
  });
});
