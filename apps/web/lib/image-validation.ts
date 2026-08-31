/**
 * Shared upload-image validation: content-sniffed format + dimensions.
 *
 * Defense model (why this exists):
 * - The declared `data:image/...` MIME is NEVER trusted — the decoded
 *   bytes are sniffed via magic signatures (stops uploads of
 *   HTML/executables disguised as images).
 * - The DECLARED format must MATCH the sniffed format (stops polyglot
 *   files that e.g. claim GIF but are PNG, which some parsers render
 *   differently than others).
 * - Dimensions are parsed from the real headers (zero-dependency) so
 *   min-size profiles are enforced server-side, not just in the UI.
 *
 * Supported: PNG, JPEG, GIF (87a/89a — animated banners/avatars), WebP.
 */

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp';

export interface ImageLimits {
  /** Minimum width/height in pixels (server-enforced). */
  minWidth: number;
  minHeight: number;
  /** Maximum width/height in pixels. */
  maxWidth: number;
  maxHeight: number;
  /** Maximum decoded byte size. */
  maxBytes: number;
  /** Maximum data-URL string length (base64 inflation ≈ 4/3). */
  maxDataUrlBytes: number;
}

/** Discord-style practical caps; avatars square-ish, banners wide. */
export const AVATAR_LIMITS: ImageLimits = {
  minWidth: 256,
  minHeight: 256,
  maxWidth: 4096,
  maxHeight: 4096,
  maxBytes: 6 * 1024 * 1024,
  maxDataUrlBytes: 6 * 1024 * 1024 * 2,
};

/** Logos: square-ish, small — rendered at 24-40px but kept generous
 *  for retina; animated GIF logos allowed like every other image. */
export const LOGO_LIMITS: ImageLimits = {
  minWidth: 64,
  minHeight: 64,
  maxWidth: 1024,
  maxHeight: 1024,
  maxBytes: 2 * 1024 * 1024,
  maxDataUrlBytes: 2 * 1024 * 1024 * 2,
};

export const BANNER_LIMITS: ImageLimits = {
  minWidth: 960,
  minHeight: 540,
  maxWidth: 4096,
  maxHeight: 4096,
  maxBytes: 8 * 1024 * 1024,
  maxDataUrlBytes: 8 * 1024 * 1024 * 2,
};

export interface ImageCheckResult {
  ok: boolean;
  error?: string;
  format?: ImageFormat;
  width?: number;
  height?: number;
}

const DATA_URL_RE = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=]+)$/;

/** Sniff the format from magic bytes (content, not the claimed MIME). */
function sniffFormat(buf: Buffer): ImageFormat | null {
  if (buf.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  // GIF87a / GIF89a: 47 49 46 38 (7a/39 61)
  if (
    buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61
  ) {
    return 'gif';
  }
  // WebP: RIFF....WEBP
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return 'webp';
  }
  return null;
}

/** PNG: IHDR width/height are big-endian uint32 at offsets 16/20. */
function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** GIF: logical screen width/height are little-endian uint16 at 6/8. */
function gifSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 10) return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

/** WebP: VP8X canvas (24-bit LE, minus one) else VP8 keyframe / VP8L. */
function webpSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 30) return null;
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    // canvas width-1 at bytes 24-26, height-1 at 27-29 (LE 24-bit)
    const w = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16));
    const h = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16));
    return { width: w, height: h };
  }
  if (chunk === 'VP8 ' && buf.length >= 30) {
    // lossy keyframe: 3-byte frame tag, then sync code 9D 01 2A, then
    // 14-bit LE width/height (minus one) at offsets 26/28.
    if (buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      const w = (buf[26]! | (buf[27]! << 8)) & 0x3fff;
      const h = (buf[28]! | (buf[29]! << 8)) & 0x3fff;
      return { width: w, height: h };
    }
    return null;
  }
  if (chunk === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
    // lossless: signature 0x2F at byte 20, then 14-bit packed dims.
    const bits = buf[21]! | (buf[22]! << 8) | (buf[23]! << 16) | (buf[24]! << 24);
    const w = (bits & 0x3fff) + 1;
    const h = ((bits >> 14) & 0x3fff) + 1;
    return { width: w, height: h };
  }
  return null;
}

/** JPEG: walk segments to the first SOFn; height/width are BE uint16. */
function jpegSize(buf: Buffer): { width: number; height: number } | null {
  let off = 2; // skip SOI
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) {
      off += 1;
      continue;
    }
    const marker = buf[off + 1]!;
    // Standalone markers without length payloads.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
      off += marker === 0xff ? 1 : 2;
      continue;
    }
    const len = buf.readUInt16BE(off + 2);
    // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC).
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof && off + 9 <= buf.length) {
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
    }
    if (len < 2) return null;
    off += 2 + len;
  }
  return null;
}

function parseSize(buf: Buffer, format: ImageFormat): { width: number; height: number } | null {
  switch (format) {
    case 'png':
      return pngSize(buf);
    case 'gif':
      return gifSize(buf);
    case 'webp':
      return webpSize(buf);
    case 'jpeg':
      return jpegSize(buf);
  }
}

/**
 * Validate a base64 image data URL against a limits profile.
 * Checks: data-URL shape → size → magic sniff → declared/sniffed match →
 * parsed dimensions → min/max bounds.
 */
export function checkImageDataUrl(dataUrl: string, limits: ImageLimits): ImageCheckResult {
  const match = DATA_URL_RE.exec(dataUrl);
  if (!match) {
    return { ok: false, error: 'Image must be a base64 PNG, JPEG, GIF, or WebP data URL.' };
  }
  if (dataUrl.length > limits.maxDataUrlBytes) {
    return { ok: false, error: `Image is too large (max ${Math.floor(limits.maxBytes / 1024 / 1024)} MB).` };
  }

  let buf: Buffer;
  try {
    buf = Buffer.from(match[2]!, 'base64');
  } catch {
    return { ok: false, error: 'Image data could not be decoded.' };
  }
  if (buf.length > limits.maxBytes) {
    return { ok: false, error: `Image is too large (max ${Math.floor(limits.maxBytes / 1024 / 1024)} MB).` };
  }

  const sniffed = sniffFormat(buf);
  if (!sniffed) {
    return { ok: false, error: 'Image data does not contain a valid image signature.' };
  }
  const declared = match[1]!.replace('jpeg', 'jpg') === 'jpg' ? 'jpeg' : (match[1] as ImageFormat);
  if (declared !== sniffed) {
    // Polyglot defense: the payload's real format must match the claim.
    return { ok: false, error: `Declared image type (${declared}) does not match the actual file contents (${sniffed}).` };
  }

  const size = parseSize(buf, sniffed);
  if (!size || !size.width || !size.height) {
    return { ok: false, error: 'Image dimensions could not be read from the file.' };
  }
  if (size.width < limits.minWidth || size.height < limits.minHeight) {
    return {
      ok: false,
      error: `Image is too small: ${size.width}×${size.height}px (minimum ${limits.minWidth}×${limits.minHeight}px).`,
      format: sniffed,
      ...size,
    };
  }
  if (size.width > limits.maxWidth || size.height > limits.maxHeight) {
    return {
      ok: false,
      error: `Image is too large: ${size.width}×${size.height}px (maximum ${limits.maxWidth}×${limits.maxHeight}px).`,
      format: sniffed,
      ...size,
    };
  }
  return { ok: true, format: sniffed, ...size };
}
