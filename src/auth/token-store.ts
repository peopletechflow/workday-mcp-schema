import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { OAuthTokens } from "./oauth.js";

const StoredRecordSchema = z.object({
  userId: z.string().min(1).max(256),
  ciphertext: z.string().min(1).max(200_000),
  iv: z.string().min(1).max(128),
  tag: z.string().min(1).max(128),
  updatedAt: z.string().max(40),
});
const StoredFileSchema = z.array(StoredRecordSchema).max(10_000);
type StoredRecord = z.infer<typeof StoredRecordSchema>;

const OAuthTokensSchema = z.object({
  accessToken: z.string().min(1).max(8192),
  refreshToken: z.string().min(1).max(8192).optional(),
  expiresAt: z.number(),
  tokenType: z.string().min(1).max(64),
  scope: z.string().max(2048).optional(),
});

export class TokenStoreCorruptError extends Error {
  constructor() {
    super("Token store file is not valid.");
    this.name = "TokenStoreCorruptError";
  }
}

/**
 * File-backed encrypted token store (AES-256-GCM).
 * The caller supplies the secret (see tokenStoreSecret in config.ts); there is no built-in fallback.
 * Additional authenticated data is `token:<userId>`, so ciphertext cannot be moved to another user.
 * A tokens.json written before that binding does not decrypt. Sign in again.
 * Replace with a proper KMS / secrets manager before production.
 */
export class TokenStore {
  private readonly key: Buffer;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly path: string,
    encryptionSecret: string,
  ) {
    this.key = createHash("sha256").update(encryptionSecret).digest();
  }

  /** Serialize read-modify-write in this process. The file write itself is a temp file plus rename. */
  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async get(userId: string): Promise<OAuthTokens | undefined> {
    return this.lock(async () => {
      const all = await this.readAll();
      const record = all.find((r) => r.userId === userId);
      if (!record) return undefined;
      return this.decrypt(record);
    });
  }

  async set(userId: string, tokens: OAuthTokens): Promise<void> {
    return this.lock(async () => {
      const all = await this.readAll();
      const encrypted = this.encrypt(userId, tokens);
      const next = all.filter((r) => r.userId !== userId);
      next.push(encrypted);
      await this.writeAll(next);
    });
  }

  async delete(userId: string): Promise<void> {
    return this.lock(async () => {
      const all = await this.readAll();
      await this.writeAll(all.filter((r) => r.userId !== userId));
    });
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
      const parsed = StoredFileSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new TokenStoreCorruptError();
      return parsed.data;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return [];
      throw err;
    }
  }

  private aad(userId: string): Buffer {
    return Buffer.from(`token:${userId}`, "utf8");
  }

  private encrypt(userId: string, tokens: OAuthTokens): StoredRecord {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(this.aad(userId));
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
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(record.iv, "base64"));
    decipher.setAAD(this.aad(record.userId));
    decipher.setAuthTag(Buffer.from(record.tag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]);
    const parsed = OAuthTokensSchema.safeParse(JSON.parse(plaintext.toString("utf8")));
    if (!parsed.success) throw new TokenStoreCorruptError();
    return parsed.data;
  }
}
