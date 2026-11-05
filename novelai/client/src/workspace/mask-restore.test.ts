import { describe, expect, it } from "vitest";
import { createMaskRestoreGate } from "./mask-restore";

describe("mask decoder restore races", () => {
  it("keeps a newer restored mask when the old image decodes last", async () => {
    const gate = createMaskRestoreGate();
    const applied: string[] = [];
    let resolveOld!: (value: string) => void;
    const old = gate.restore(() => new Promise<string>((resolve) => { resolveOld = resolve; }), () => true, (value) => applied.push(value));
    expect(await gate.restore(async () => "new", () => true, (value) => applied.push(value))).toBe(true);
    resolveOld("old");
    expect(await old).toBe(false);
    expect(applied).toEqual(["new"]);
  });

  it("does not overwrite a manual edit or a different workbench after decode", async () => {
    const gate = createMaskRestoreGate();
    const applied: string[] = [];
    expect(await gate.restore(async () => "decoded", () => false, (value) => applied.push(value))).toBe(false);
    const pending = gate.restore(async () => "cancelled", () => true, (value) => applied.push(value));
    gate.cancel();
    expect(await pending).toBe(false);
    expect(applied).toEqual([]);
  });
});
