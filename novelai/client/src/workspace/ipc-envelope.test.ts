import { expect, it } from "vitest";
import { unwrapIpcResponse } from "./adapter";

// Kept from the removed gallery tests: generation, batch and prompt-review IPC still
// return { ok, result | error } envelopes that the renderer unwraps here.
it("unwraps structured IPC envelopes, preserving error codes and rejecting malformed ones", async () => {
  await expect(unwrapIpcResponse(Promise.resolve({ ok: true as const, result: "unchanged" }))).resolves.toBe("unchanged");
  await expect(unwrapIpcResponse(Promise.resolve({ ok: false as const, error: { code: "upstream_error", message: "HTTP 503" } }))).rejects.toMatchObject({ code: "upstream_error", message: "HTTP 503" });
  await expect(unwrapIpcResponse(Promise.resolve({ ok: false, error: { message: "missing code" } } as any))).rejects.toMatchObject({ code: "invalid_response" });
  await expect(unwrapIpcResponse(Promise.resolve(null as any))).rejects.toMatchObject({ code: "invalid_response" });
});
