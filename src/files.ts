// Files a pad's agent uploads (images, fonts, audio, video, 3D models, data), stored in R2 under <pad id>/<name>
// and served only from that pad's own address.

export type FileType = { ext: string; contentType: string };

const TYPES: Record<string, string> = {
  jpg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf",
  mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", mp4: "video/mp4", webm: "video/webm",
  glb: "model/gltf-binary", json: "application/json", csv: "text/csv; charset=utf-8", txt: "text/plain; charset=utf-8",
};
const TEXT = new Set(["svg", "json", "csv", "txt"]);
const type = (ext: string): FileType => ({ ext, contentType: TYPES[ext] });

// Binary formats are known by their first bytes, whatever their name; text formats by their name and valid UTF-8.
export function fileTypeOf(bytes: Uint8Array, name = ""): FileType | undefined {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
  if (starts(0xff, 0xd8, 0xff)) return type("jpg");
  if (starts(0x89, 0x50, 0x4e, 0x47)) return type("png");
  if (ascii(0, 4) === "GIF8") return type("gif");
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return type("webp");
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return type("wav");
  if (ascii(0, 4) === "wOF2") return type("woff2");
  if (ascii(0, 4) === "wOFF") return type("woff");
  if (starts(0x00, 0x01, 0x00, 0x00)) return type("ttf");
  if (ascii(0, 4) === "OTTO") return type("otf");
  if (ascii(0, 3) === "ID3" || starts(0xff, 0xfb) || starts(0xff, 0xf3) || starts(0xff, 0xf2)) return type("mp3");
  if (ascii(0, 4) === "OggS") return type("ogg");
  if (ascii(4, 8) === "ftyp") return type("mp4");
  if (starts(0x1a, 0x45, 0xdf, 0xa3)) return type("webm");
  if (ascii(0, 4) === "glTF") return type("glb");
  const ext = name.toLowerCase().match(/\.(\w+)$/)?.[1] ?? "";
  if (!TEXT.has(ext)) return undefined;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return type(ext);
  } catch {
    return undefined;
  }
}

export const FILE_NAME = new RegExp(`^[2-9a-z]{8}\\.(?:${Object.keys(TYPES).join("|")})$`);

export const fileHeaders = (contentType: string): Record<string, string> => ({
  "content-type": contentType,
  // An SVG opened on its own runs nothing; inside a pad it is an image, which never runs scripts.
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex",
  // Pads under /p/ run in an opaque origin, so their fonts and fetch() calls are cross-origin.
  "access-control-allow-origin": "*",
  // A day, not forever: a pad taken down after reports must stop showing its files soon.
  "cache-control": "public, max-age=86400",
});

// R2 deletes at most 1000 keys per call.
export async function deleteFileObjects(bucket: R2Bucket, keys: string[]) {
  for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
}
