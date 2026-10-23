// Images a pad's agent uploads, stored in R2 under <pad id>/<name> and served only from that pad's own address.

export type ImageType = { ext: string; contentType: string };

// Known raster formats only, read from the file's first bytes: SVG is refused because it can carry scripts.
export function imageTypeOf(bytes: Uint8Array): ImageType | undefined {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0xff, 0xd8, 0xff)) return { ext: "jpg", contentType: "image/jpeg" };
  if (starts(0x89, 0x50, 0x4e, 0x47)) return { ext: "png", contentType: "image/png" };
  if (starts(0x47, 0x49, 0x46, 0x38)) return { ext: "gif", contentType: "image/gif" };
  if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return { ext: "webp", contentType: "image/webp" };
  return undefined;
}

export const IMAGE_NAME = /^[2-9a-z]{8}\.(?:jpg|png|gif|webp)$/;

export const imageHeaders = (contentType: string): Record<string, string> => ({
  "content-type": contentType,
  "content-security-policy": "default-src 'none'",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex",
  // A day, not forever: a pad taken down after reports must stop showing its images soon.
  "cache-control": "public, max-age=86400",
});

// R2 deletes at most 1000 keys per call.
export async function deleteImageObjects(bucket: R2Bucket, keys: string[]) {
  for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
}
