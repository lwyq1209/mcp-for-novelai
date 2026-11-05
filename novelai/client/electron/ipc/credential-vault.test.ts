import { describe, expect, it, vi } from "vitest";
import { CredentialVault, CREDENTIAL_PREFIX as prefix } from "./credential-vault";

function create(available = true) {
  const crypto = {
    isEncryptionAvailable: () => available,
    encryptString: (v: string) => Buffer.from(`stable:${v}`),
    decryptString: (v: Buffer) => {
      if (!v.toString().startsWith("stable:")) throw Error("other profile");
      return v.toString().slice(7);
    },
  };
  return { vault: new CredentialVault(crypto), crypto };
}
const locked = prefix + Buffer.from("legacy:secret").toString("base64");
describe("credential encryption context", () => {
  it("does not expose locked ciphertext as a configured key", () => {
    const {vault} = create();
    expect(vault.decode("exampleApiKey", locked)).toBe("");
    expect(vault.issues()).toEqual(["exampleApiKey"]);
    expect(vault.encode("exampleApiKey", "")).toBe(locked);
  });
  it("preserves unresolved originals during unrelated saves and explicit reset is separate", () => {
    const {vault} = create(); vault.decode("token", locked);
    expect(vault.encode("token", undefined)).toBe(locked);
    vault.forget("token");
    expect(vault.encode("token", "")).toBe("");
  });
  it("round-trips new credentials and never silently saves plaintext if encryption fails", () => {
    const {vault, crypto} = create();
    const encrypted = vault.encode("token", "value");
    expect(encrypted).not.toBe("value");
    expect(vault.decode("token", encrypted)).toBe("value");
    vi.spyOn(crypto,"encryptString").mockImplementation(() => {throw Error("disk");});
    expect(() => vault.encode("token", "replacement")).toThrow("disk");
  });
  it("retains encrypted data when OS key storage is temporarily unavailable", () => {
    const {vault} = create(false);
    expect(vault.decode("token", locked)).toBe("");
    expect(vault.encode("token", "")).toBe(locked);
    expect(() => vault.encode("token", "new")).toThrow();
  });
  it("does not use a plaintext value, reports it as an unsupported format and does not write it back", () => {
    const {vault} = create();
    expect(vault.decode("token", "plain-secret")).toBe("");
    expect(vault.issues()).toEqual(["token:unsupported-format"]);
    expect(vault.encode("token", "")).toBe("");
    expect(vault.encode("token", undefined)).toBeUndefined();
    vault.forget("token"); expect(vault.issues()).toEqual([]);
    vault.decode("token", "plain-secret"); vault.reset(); expect(vault.issues()).toEqual([]);
  });
  it("clears failed state after successful unlock and does not affect zero/empty non-secrets", () => {
    const {vault} = create();vault.decode("token", locked);
    const good = prefix + Buffer.from("stable:recovered").toString("base64");
    expect(vault.decode("token", good)).toBe("recovered");expect(vault.issues()).toEqual([]);
    expect(vault.decode("blank", "")).toBe("");expect(vault.decode("zero", 0)).toBe(0);
  });
});
