import { toHex } from "./crypto";

export const PBKDF2_ITERATIONS = 100_000;
const KEY_BITS = 256;

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    KEY_BITS,
  );
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function validatePassword(password: string): string | null {
  if (!password || password.length < 8) return "password must be at least 8 characters";
  if (password.length > 128) return "password too long";
  return null;
}

export async function hashPassword(
  password: string,
  iterations = PBKDF2_ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await pbkdf2(password, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${toHex(salt)}$${toHex(derived)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 1) return false;
  try {
    const salt = fromHex(parts[2]);
    const derived = toHex(await pbkdf2(password, salt, iterations));
    return timingSafeEqualHex(derived, parts[3]);
  } catch {
    return false;
  }
}
