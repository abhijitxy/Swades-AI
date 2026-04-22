/**
 * Compute a SHA-256 checksum hex string from raw bytes.
 */
export async function computeChecksum(data: Uint8Array | ArrayBuffer): Promise<string> {
  const buffer = data instanceof ArrayBuffer ? data : data.buffer;
  const hash = await crypto.subtle.digest("SHA-256", buffer as ArrayBuffer);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
