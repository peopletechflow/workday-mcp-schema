/** Owner-only JSON files (ASU sessions). Refuses symlinks and foreign owners; writes atomically via an exclusive random temp file. */
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

function assertSafeTarget(path: string) {
  let st; try { st = lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
  if (st.isSymbolicLink()) throw new Error(`Refusing symlink at ${path}.`);
  if (!st.isFile()) throw new Error(`Refusing non-file at ${path}.`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`Refusing ${path}: owned by another user.`);
  if ((st.mode & 0o077) !== 0) throw new Error(`Refusing ${path}: readable by group or others (chmod 600).`);
}

export function writeOwnerOnlyJson(path: string, data: unknown) {
  assertSafeTarget(path);
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(12).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try { writeSync(fd, JSON.stringify(data)); fsyncSync(fd); closeSync(fd); renameSync(tmp, path); }
  catch (e) { try { closeSync(fd); } catch {} try { unlinkSync(tmp); } catch {} throw e; }
}

export function readOwnerOnlyJson(path: string): unknown {
  assertSafeTarget(path);
  return JSON.parse(readFileSync(path, "utf8"));
}
