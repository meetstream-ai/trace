export async function readResponseBytes(response: Response, limit: number) {
  if (!response.body || Number(response.headers.get("content-length")) > limit)
    throw new Error(
      "The provider response is unavailable or exceeds the size limit.",
    );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit)
        throw new Error("The provider response exceeds the size limit.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readResponseJson(
  response: Response,
  limit = 1024 * 1024,
): Promise<unknown> {
  return JSON.parse(
    new TextDecoder().decode(await readResponseBytes(response, limit)),
  );
}
