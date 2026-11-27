const encoder = new TextEncoder();

async function signingKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function signedContent(id: string, timestamp: string, rawBody: string) {
  return encoder.encode(`${id}.${timestamp}.${rawBody}`);
}

export async function signWebhook(
  secret: string,
  id: string,
  timestamp: string,
  rawBody: string,
) {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret),
    signedContent(id, timestamp, rawBody),
  );
  return "v1=" + Buffer.from(signature).toString("hex");
}

export async function verifyWebhook(
  secret: string,
  headers: Headers,
  rawBody: string,
  now = Date.now(),
) {
  const id = headers.get("X-Trace-Delivery") ?? "";
  const timestamp = headers.get("X-Trace-Timestamp") ?? "";
  const signature = headers.get("X-Trace-Signature") ?? "";
  if (
    secret.length < 32 ||
    !/^[a-f0-9-]{36}$/.test(id) ||
    !/^\d{10}$/.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300 ||
    !/^v1=[a-f0-9]{64}$/.test(signature)
  )
    return false;
  return crypto.subtle.verify(
    "HMAC",
    await signingKey(secret),
    Buffer.from(signature.slice(3), "hex"),
    signedContent(id, timestamp, rawBody),
  );
}
