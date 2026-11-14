/**
 * Envelope-free AES-256-GCM sealing for tokens and PKCE verifiers stored in Postgres.
 * Keys come from env references only (base64, 32 bytes). AAD binds ciphertext to its row
 * (tenant + user + purpose) so rows cannot be swapped. A previous key can be supplied for
 * rotation (decrypt only). There is no built-in fallback key.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type Sealed = { keyId: string; iv: string; tag: string; ciphertext: string };

export class KeyRing {
  private readonly keys = new Map<string, Buffer>();
  constructor(
    readonly activeKeyId: string,
    active: Buffer,
    previous?: { id: string; key: Buffer },
  ) {
    if (active.length !== 32) throw new Error("Encryption key must be 32 bytes (base64).");
    this.keys.set(activeKeyId, active);
    if (previous) {
      if (previous.key.length !== 32) throw new Error("Previous encryption key must be 32 bytes.");
      this.keys.set(previous.id, previous.key);
    }
  }
  static fromEnv(env: NodeJS.ProcessEnv): KeyRing {
    const raw = env.TOKEN_ENCRYPTION_KEY;
    const id = env.TOKEN_ENCRYPTION_KEY_ID;
    if (!raw || !id)
      throw new Error("TOKEN_ENCRYPTION_KEY and TOKEN_ENCRYPTION_KEY_ID are required (no fallback key).");
    const prev =
      env.TOKEN_ENCRYPTION_KEY_PREVIOUS && env.TOKEN_ENCRYPTION_KEY_PREVIOUS_ID
        ? { id: env.TOKEN_ENCRYPTION_KEY_PREVIOUS_ID, key: Buffer.from(env.TOKEN_ENCRYPTION_KEY_PREVIOUS, "base64") }
        : undefined;
    return new KeyRing(id, Buffer.from(raw, "base64"), prev);
  }
  seal(plaintext: string, aad: string): Sealed {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.keys.get(this.activeKeyId)!, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return {
      keyId: this.activeKeyId,
      iv: iv.toString("base64"),
      tag: c.getAuthTag().toString("base64"),
      ciphertext: ct.toString("base64"),
    };
  }
  open(s: Sealed, aad: string): string {
    const key = this.keys.get(s.keyId);
    if (!key) throw new Error(`Unknown encryption key id ${s.keyId}`);
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(s.iv, "base64"));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(s.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(s.ciphertext, "base64")), d.final()]).toString("utf8");
  }
  /** Compact single-string form for small values (PKCE verifiers). */
  sealCompact(plaintext: string, aad: string): string {
    const s = this.seal(plaintext, aad);
    return [s.keyId, s.iv, s.tag, s.ciphertext].join(".");
  }
  openCompact(v: string, aad: string): string {
    const [keyId, iv, tag, ciphertext] = v.split(".");
    if (!keyId || !iv || !tag || !ciphertext) throw new Error("Malformed sealed value");
    return this.open({ keyId, iv, tag, ciphertext }, aad);
  }
}
