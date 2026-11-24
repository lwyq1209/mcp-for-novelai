import { describe, expect, it } from "vitest";
import contracts from "./generated/library-contracts.json";
import {
  PRECISE_REFERENCE_TYPES, isPreciseReferenceType, preciseReferenceBaseType, preciseReferenceSameOutfit, preciseReferenceTypeOf,
  resolveNAIPreciseReferences, type PreciseReferenceType,
} from "./types";

/** Every enum of the generated library contract that lists precise reference types (the preset payload and its update). */
function contractTypeEnums(node: unknown, found: string[][] = []): string[][] {
  if (Array.isArray(node)) { for (const item of node) contractTypeEnums(item, found); return found; }
  if (!node || typeof node !== "object") return found;
  for (const [key, value] of Object.entries(node)) {
    if (key === "preciseType" && value && typeof value === "object" && Array.isArray((value as { enum?: unknown }).enum)) found.push((value as { enum: string[] }).enum);
    else contractTypeEnums(value, found);
  }
  return found;
}

describe("precise reference types", () => {
  it("are the same list in the client and in every place of the library contract", () => {
    const enums = contractTypeEnums(contracts);
    expect(enums.length).toBeGreaterThanOrEqual(2);
    for (const list of enums) expect([...list].sort()).toEqual([...PRECISE_REFERENCE_TYPES].sort());
    expect(isPreciseReferenceType("costume")).toBe(true);
    expect(isPreciseReferenceType("outfit")).toBe(false);
  });

  it("\"same outfit\" is the type itself, with the official defaults when a kind is picked", () => {
    const rows: Array<[PreciseReferenceType, string, boolean | null]> = [
      ["character", "character", false], ["character_mainoutfit", "character", true],
      ["character&style", "character&style", true], ["character&style_anyoutfit", "character&style", false],
      ["style", "style", null], ["costume", "costume", null],
    ];
    for (const [type, base, sameOutfit] of rows) {
      expect(preciseReferenceBaseType(type)).toBe(base);
      expect(preciseReferenceSameOutfit(type)).toBe(sameOutfit);
      expect(preciseReferenceTypeOf(preciseReferenceBaseType(type), sameOutfit ?? undefined)).toBe(type);
    }
    // Picking a kind alone: Character does not follow the outfit, Character & Style does (the official dropdown).
    expect(preciseReferenceTypeOf("character")).toBe("character");
    expect(preciseReferenceTypeOf("character&style")).toBe("character&style");
    expect(preciseReferenceTypeOf("costume", true)).toBe("costume");
  });

  it("resolves what a model's request carries, as the official client filters it", () => {
    const references = PRECISE_REFERENCE_TYPES.map(type => ({ type, fidelity: 0.3, strength: 2 }));
    expect(resolveNAIPreciseReferences(references, "nai-diffusion-5-full")).toEqual(references.map(reference => ({ ...reference, fidelity: 1 })));
    expect(resolveNAIPreciseReferences(references, "nai-diffusion-4-5-curated").map(reference => [reference.type, reference.fidelity, reference.strength]))
      .toEqual([["character", 0.3, 2], ["character", 0.3, 2], ["style", 0.3, 2], ["character&style", 0.3, 2], ["character&style", 0.3, 2]]);
    expect(resolveNAIPreciseReferences(references, "nai-diffusion-4-full")).toEqual([]);
    expect(resolveNAIPreciseReferences(undefined, "nai-diffusion-5-full")).toEqual([]);
    const once = resolveNAIPreciseReferences(references, "nai-diffusion-4-5-full");
    expect(resolveNAIPreciseReferences(once, "nai-diffusion-4-5-full")).toEqual(once);
  });
});
