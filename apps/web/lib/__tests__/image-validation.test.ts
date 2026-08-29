import { describe, expect, it } from 'vitest';
import { AVATAR_LIMITS, BANNER_LIMITS, checkImageDataUrl } from '../image-validation.js';

/**
 * Builds a REAL minimal image header with the requested dimensions so the
 * dimension parser reads actual bytes (no mocks).
 */
function png1x1(width: number, height: number): string {
  const buf = Buffer.alloc(24);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // PNG sig
  buf.set(Buffer.from('IHDR'), 12);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

function gif(width: number, height: number): string {
  const buf = Buffer.alloc(13);
  buf.set(Buffer.from('GIF89a'), 0);
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return `data:image/gif;base64,${buf.toString('base64')}`;
}

function gif87(width: number, height: number): string {
  const buf = Buffer.alloc(13);
  buf.set(Buffer.from('GIF87a'), 0);
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return `data:image/gif;base64,${buf.toString('base64')}`;
}

function webpVp8L(width: number, height: number): string {
  const buf = Buffer.alloc(30);
  buf.set(Buffer.from('RIFF'), 0);
  buf.writeUInt32LE(16, 4);
  buf.set(Buffer.from('WEBP'), 8);
  buf.set(Buffer.from('VP8L'), 12);
  buf[20] = 0x2f; // lossless signature
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  buf[21] = bits & 0xff;
  buf[22] = (bits >> 8) & 0xff;
  buf[23] = (bits >> 16) & 0xff;
  buf[24] = (bits >> 24) & 0xff;
  return `data:image/webp;base64,${buf.toString('base64')}`;
}

function jpeg(width: number, height: number): string {
  // SOI + APP0(JFIF) + SOF0 carrying the dimensions.
  const parts: Buffer[] = [];
  parts.push(Buffer.from([0xff, 0xd8, 0xff]));
  // SOF0: marker, length(17), precision(8), height, width, 1 component
  const sof = Buffer.alloc(17);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 1;
  parts.push(sof);
  return `data:image/jpeg;base64,${Buffer.concat(parts).toString('base64')}`;
}

describe('checkImageDataUrl — formats', () => {
  it('accepts a valid PNG with avatar dimensions', () => {
    const res = checkImageDataUrl(png1x1(512, 512), AVATAR_LIMITS);
    expect(res.ok).toBe(true);
    expect(res.format).toBe('png');
    expect(res.width).toBe(512);
    expect(res.height).toBe(512);
  });

  it('accepts GIF89a AND GIF87a (animated banner support)', () => {
    expect(checkImageDataUrl(gif(1280, 720), BANNER_LIMITS).ok).toBe(true);
    expect(checkImageDataUrl(gif87(1280, 720), BANNER_LIMITS).ok).toBe(true);
  });

  it('parses WebP (VP8L) and JPEG dimensions', () => {
    const webp = checkImageDataUrl(webpVp8L(1920, 1080), BANNER_LIMITS);
    expect(webp.ok).toBe(true);
    expect(webp.format).toBe('webp');
    expect(webp.width).toBe(1920);

    const jpg = checkImageDataUrl(jpeg(1280, 720), BANNER_LIMITS);
    expect(jpg.ok).toBe(true);
    expect(jpg.format).toBe('jpeg');
    expect(jpg.height).toBe(720);
  });

  it('rejects a declared MIME that does not match the payload (polyglot defense)', () => {
    // PNG bytes declared as GIF.
    const pngAsGif = png1x1(1280, 720).replace('image/png', 'image/gif');
    const res = checkImageDataUrl(pngAsGif, BANNER_LIMITS);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/does not match/i);
  });

  it('rejects non-image payloads regardless of the claim', () => {
    const html = `data:image/png;base64,${Buffer.from('<script>alert(1)</script>....').toString('base64')}`;
    expect(checkImageDataUrl(html, BANNER_LIMITS).ok).toBe(false);
  });
});

describe('checkImageDataUrl — dimension limits', () => {
  it('avatar requires at least 256×256', () => {
    const tooSmall = checkImageDataUrl(png1x1(200, 256), AVATAR_LIMITS);
    expect(tooSmall.ok).toBe(false);
    expect(tooSmall.error).toMatch(/too small/i);

    expect(checkImageDataUrl(png1x1(256, 256), AVATAR_LIMITS).ok).toBe(true);
  });

  it('banner requires at least 960×540', () => {
    expect(checkImageDataUrl(gif(960, 500), BANNER_LIMITS).ok).toBe(false);
    expect(checkImageDataUrl(gif(960, 540), BANNER_LIMITS).ok).toBe(true);
  });

  it('caps at 4096×4096', () => {
    expect(checkImageDataUrl(png1x1(5000, 540), BANNER_LIMITS).ok).toBe(false);
    expect(checkImageDataUrl(png1x1(4096, 2160), BANNER_LIMITS).ok).toBe(true);
  });
});
