export const MAX_BYTES = 8 * 1024 * 1024;

export const ALLOWED_TYPES: Record<string, { ext: string; kind: "image" | "file" }> = {
  "image/jpeg": { ext: "jpg", kind: "image" },
  "image/png": { ext: "png", kind: "image" },
  "image/gif": { ext: "gif", kind: "image" },
  "image/webp": { ext: "webp", kind: "image" },
  "application/pdf": { ext: "pdf", kind: "file" },
  "application/zip": { ext: "zip", kind: "file" },
  "text/plain": { ext: "txt", kind: "file" },
  "text/markdown": { ext: "md", kind: "file" },
};

const EXT_TO_TYPE: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  zip: "application/zip",
  txt: "text/plain",
  md: "text/markdown",
};

export function sniffType(contentType: string | null, filename: string): string | null {
  const raw = (contentType || "").split(";")[0].trim().toLowerCase();
  if (raw && ALLOWED_TYPES[raw]) return raw;
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return EXT_TO_TYPE[ext] ?? null;
}

export function mediaKey(roomId: string, objectId: string, ext: string): string {
  return `room/${roomId}/${objectId}.${ext}`;
}

export function parseMediaKey(key: string): { roomId: string } | null {
  const m = /^room\/([^/]+)\/[^/]+$/.exec(key);
  return m ? { roomId: m[1] } : null;
}
