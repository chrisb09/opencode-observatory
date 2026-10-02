import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual, createCipheriv, createDecipheriv, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { pool } from "./db.js";
import type { FastifyRequest } from "fastify";
const scrypt = promisify(scryptCallback);
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const token = () => randomBytes(32).toString("base64url");
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = await scrypt(password, salt, 64) as Buffer;
  return `${salt}:${key.toString("hex")}`;
}
export async function passwordValid(password: string, stored: string) {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  const actual = await scrypt(password, salt, 64) as Buffer;
  const bytes = Buffer.from(expected, "hex");
  return bytes.length === actual.length && timingSafeEqual(bytes, actual);
}
function encryptionKey() {
  const key = Buffer.from(process.env.ENCRYPTION_KEY ?? "", "hex");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be 64 hex characters (32 random bytes)");
  return key;
}
export function encrypt(value: string) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), bytes].map(x => x.toString("base64url")).join(".");
}
export function decrypt(value: string) {
  const [iv, tag, bytes] = value.split(".").map(x => Buffer.from(x, "base64url"));
  if (!iv || !tag || !bytes) throw new Error("Invalid encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(bytes), decipher.final()]).toString("utf8");
}
export function validateSecurityConfig() { encryptionKey(); new URL(process.env.PUBLIC_URL ?? "http://localhost:7692"); }
export class HttpError extends Error { constructor(public statusCode: number, message: string) { super(message); } }
export type Principal = { id: string; email: string; admin: boolean; keyId?: string; scopes?: string[] };
export async function authenticate(request: FastifyRequest, scope?: string): Promise<Principal> {
  const bearer = request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
  if (bearer) {
    const { rows } = await pool.query(`SELECT u.id,u.email,u.admin,k.id AS key_id,k.scopes FROM api_keys k JOIN users u ON u.id=k.user_id
      WHERE k.token_hash=$1 AND k.revoked_at IS NULL`, [hash(bearer)]);
    const row = rows[0]; if (!row || (scope && !row.scopes.includes(scope))) throw new HttpError(401, "API key is invalid or lacks the required scope");
    await pool.query("UPDATE api_keys SET last_used_at=now() WHERE id=$1", [row.key_id]);
    return { id: row.id, email: row.email, admin: false, keyId: row.key_id, scopes: row.scopes };
  }
  if (scope === "ingest") throw new HttpError(401, "Telemetry API key required");
  const session = request.cookies.obs_session;
  const { rows } = await pool.query(`SELECT u.id,u.email,u.admin FROM login_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()`, [hash(session ?? "")]);
  if (!rows[0]) throw new HttpError(401, "Please sign in");
  return rows[0];
}
export async function browserUser(request: FastifyRequest) {
  const user = await authenticate(request);
  if (user.keyId) throw new HttpError(403, "Dashboard login required");
  return user;
}
export function isAllowedOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    const expected = new URL(process.env.PUBLIC_URL ?? "http://localhost:7692");
    if (originUrl.origin === expected.origin) return true;
    if (process.env.NODE_ENV !== "production" && origin === "http://127.0.0.1:5173") return true;
    const additional = (process.env.ALLOWED_ORIGINS ?? "").split(",").map(s => s.trim()).filter(Boolean);
    if (additional.includes(originUrl.origin)) return true;
    if (host && originUrl.host === host) return true;
    return false;
  } catch {
    return false;
  }
}
export function checkOrigin(request: FastifyRequest) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method) || request.headers.authorization?.startsWith("Bearer ")) return;
  const origin = request.headers.origin;
  if (!isAllowedOrigin(origin, request.headers.host)) throw new HttpError(403, "Invalid request origin");
}
export async function createUser(email: string, password: string, admin = false, db: { query: typeof pool.query } = pool) {
  const id = randomUUID();
  await db.query("INSERT INTO users(id,email,password_hash,admin,fingerprint_secret) VALUES($1,$2,$3,$4,$5)", [id, email.trim().toLowerCase(), await passwordHash(password), admin, encrypt(token())]);
  return id;
}

export async function bootstrapAdmin(log = console.log) {
  const emailRaw = process.env.ADMIN_EMAIL?.trim();
  const passwordRaw = process.env.ADMIN_PASSWORD;
  if (!emailRaw && !passwordRaw) return;
  if (!emailRaw || !passwordRaw) {
    log("[Observatory] Both ADMIN_EMAIL and ADMIN_PASSWORD must be provided to auto-provision an initial administrator.");
    return;
  }
  const email = emailRaw.toLowerCase();
  if (!email.includes("@")) {
    log(`[Observatory] ADMIN_EMAIL "${emailRaw}" is not a valid email address; skipping auto-provisioning.`);
    return;
  }
  if (passwordRaw.length < 12) {
    log("[Observatory] ADMIN_PASSWORD must be at least 12 characters; skipping auto-provisioning.");
    return;
  }
  try {
    const existing = await pool.query("SELECT email FROM users WHERE admin=true LIMIT 1");
    if (existing.rowCount) {
      return;
    }
    await createUser(email, passwordRaw, true);
    log(`[Observatory] Initial administrator created for ${email}`);
  } catch (error) {
    log(`[Observatory] Could not auto-provision administrator: ${(error as Error).message}`);
  }
}
