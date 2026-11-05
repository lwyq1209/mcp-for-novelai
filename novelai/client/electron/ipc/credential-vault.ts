import { CREDENTIAL_FORMAT_ISSUE_SUFFIX } from "../../src/types";

export const CREDENTIAL_PREFIX = "enc:v1:";
/** Settings encrypted at rest besides the NovelAI token (which is handled on its own).
 * Empty: the third-party API keys of the removed reverse/convert/translate/tag
 * server features are no longer stored. */
export const SENSITIVE_SETTING_KEYS: readonly string[] = [];

type Cryptography = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

export class CredentialVault {
  private readonly locked = new Map<string, string>();
  /** Keys whose stored value was a non-empty string without CREDENTIAL_PREFIX: not this version's format. */
  private readonly unsupported = new Set<string>();
  constructor(private readonly crypto: Cryptography) {}
  issues() { return [...this.locked.keys(), ...[...this.unsupported].map(key => `${key}${CREDENTIAL_FORMAT_ISSUE_SUFFIX}`)]; }
  forget(key: string) { this.locked.delete(key); this.unsupported.delete(key); }
  reset() { this.locked.clear(); this.unsupported.clear(); }
  decode(key: string, value: unknown): unknown {
    if (typeof value !== "string" || !value) return value;
    // A plaintext credential is never written by this version: it is not used (no request is sent with it), it is
    // reported, and as the value is now empty the next write leaves it out.
    if (!value.startsWith(CREDENTIAL_PREFIX)) { this.unsupported.add(key); return ""; }
    try {
      if (!this.crypto.isEncryptionAvailable()) throw new Error("locked");
      const result = this.crypto.decryptString(Buffer.from(value.slice(CREDENTIAL_PREFIX.length), "base64"));
      this.locked.delete(key);
      return result;
    } catch {
      this.locked.set(key, value);
      // Never send ciphertext to a provider or expose it as an editable key.
      return "";
    }
  }
  encode(key: string, value: unknown): unknown {
    // An unrelated settings/history save must preserve an unrecovered secret.
    if ((value == null || value === "") && this.locked.has(key)) return this.locked.get(key);
    if (typeof value !== "string" || !value || value.startsWith(CREDENTIAL_PREFIX)) return value;
    if (!this.crypto.isEncryptionAvailable()) throw new Error("本地凭据加密暂不可用，请稍后重试。");
    return CREDENTIAL_PREFIX + this.crypto.encryptString(value).toString("base64");
  }
}
