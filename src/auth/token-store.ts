import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
 * Key is derived from WORKDAY_TOKEN_ENCRYPTION_KEY or a local-dev fallback.
 * Replace with a proper KMS / secrets manager before production.
 */
export class TokenStore {
  private readonly key: Buffer;

  constructor(
    private readonly path: string,
    encryptionSecret: string = process.env.WORKDAY_TOKEN_ENCRYPTION_KEY ??
      "local-dev-only-change-me",
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
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(next, null, 2), { mode: 0o600 });
  }

  async delete(userId: string): Promise<void> {
    const all = await this.readAll();
    const next = all.filter((r) => r.userId !== userId);
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(next, null, 2), { mode: 0o600 });
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
