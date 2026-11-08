import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { OAuthTokens } from "./oauth.js";

type StoredRecord = {
  userId: string;
  ciphertext: string;
  iv: string;
  tag: string;
  updatedAt: string;
};

/**
 * File-backed encrypted token store (AES-256-GCM).
 * The caller supplies the secret (see tokenStoreSecret in config.ts); there is no built-in fallback.
 * Replace with a proper KMS / secrets manager before production.
 */
export class TokenStore {
  private readonly key: Buffer;

  constructor(
    private readonly path: string,
    encryptionSecret: string,
  ) {
    this.key = createHash("sha256").update(encryptionSecret).digest();
  }

  async get(userId: string): Promise<OAuthTokens | undefined> {
    const all = await this.readAll();
    const record = all.find((r) => r.userId === userId);
    if (!record) return undefined;
    return this.decrypt(record);
  }

  async set(userId: string, tokens: OAuthTokens): Promise<void> {
    const all = await this.readAll();
    const encrypted = this.encrypt(userId, tokens);
    const next = all.filter((r) => r.userId !== userId);
    next.push(encrypted);
    await this.writeAll(next);
  }

  async delete(userId: string): Promise<void> {
    const all = await this.readAll();
    await this.writeAll(all.filter((r) => r.userId !== userId));
  }

  /** Write to a temp file then rename, so a crash never leaves a truncated store. Owner-only. */
  private async writeAll(records: StoredRecord[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(records, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
    await chmod(this.path, 0o600);
  }

  private async readAll(): Promise<StoredRecord[]> {
    try {
      const raw = await readFile(this.path, "utf8");
      return JSON.parse(raw) as StoredRecord[];
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return [];
      throw err;
    }
  }

  private encrypt(userId: string, tokens: OAuthTokens): StoredRecord {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(tokens), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      userId,
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      updatedAt: new Date().toISOString(),
    };
  }

  private decrypt(record: StoredRecord): OAuthTokens {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(record.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(record.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8")) as OAuthTokens;
  }
}
