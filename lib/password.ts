import { timingSafeEqual } from "node:crypto";

async function derive(password: string, salt: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: encoder.encode(salt),
        iterations: 100_000,
      },
      key,
      256,
    ),
  );
}

export async function hashPassword(password: string) {
  const salt = crypto.randomUUID();
  return salt + "." + Buffer.from(await derive(password, salt)).toString("hex");
}

export async function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(".");
  if (!salt || !/^[a-f0-9]{64}$/.test(hash ?? "")) return false;
  return timingSafeEqual(
    await derive(password, salt),
    Buffer.from(hash, "hex"),
  );
}
