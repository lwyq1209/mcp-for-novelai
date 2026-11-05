import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertPromptAssemblyVersion,
  DEFAULT_PARAMS,
  normalizeInheritedGenerateParams,
  type GenerateParams,
} from "./types";

function legacyParams(): GenerateParams {
  const params = { ...DEFAULT_PARAMS, positivePrompt: "one, one", negativePrompt: "bad, bad", steps: 31 };
  delete params.promptAssemblyVersion;
  return params;
}

describe("prompt assembly entry-point boundaries", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
  });

  it.each([0, 2, "1", null, false, undefined])(
    "rejects an explicit invalid marker before inherited normalization (%s)",
    (value) => {
      const incoming = { ...legacyParams(), promptAssemblyVersion: value } as unknown as Partial<GenerateParams>;
      expect(() => assertPromptAssemblyVersion(incoming)).toThrow(/promptAssemblyVersion/);
      expect(() => normalizeInheritedGenerateParams(incoming, DEFAULT_PARAMS)).toThrow(/promptAssemblyVersion/);
    },
  );

  it("allows the internal undefined clear sentinel only when explicitly requested", () => {
    const patch = { promptAssemblyVersion: undefined };
    expect(() => assertPromptAssemblyVersion(patch)).toThrow(/promptAssemblyVersion/);
    expect(() => assertPromptAssemblyVersion(patch, { allowUndefinedClear: true })).not.toThrow();
  });
});
