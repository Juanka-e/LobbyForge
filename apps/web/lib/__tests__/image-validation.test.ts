import { describe, expect, it } from 'vitest';
import { AVATAR_LIMITS, BANNER_LIMITS, checkImageDataUrl, decodeImageDataUrl, readGifStructure } from '../image-validation.js';

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

interface GifFrame {
  left?: number;
  top?: number;
  width: number;
  height: number;
  /** Local colour table size exponent (table of 2^(n+1) entries), or none. */
  localTable?: number;
}

/**
 * A REAL GIF, block by block: header, logical screen (optionally with a
 * global colour table), a graphic-control and a comment extension, each
 * frame's image descriptor + LZW data sub-blocks, then the trailer.
 */
function gifBytes(
  width: number,
  height: number,
  options: { version?: '87a' | '89a'; frames?: GifFrame[]; globalTable?: number; trailer?: boolean } = {}
): Buffer {
  const parts: Buffer[] = [Buffer.from(`GIF${options.version ?? '89a'}`)];
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(width, 0);
  screen.writeUInt16LE(height, 2);
  if (options.globalTable !== undefined) screen[4] = 0x80 | options.globalTable;
  parts.push(screen);
  if (options.globalTable !== undefined) parts.push(Buffer.alloc(3 * (1 << (options.globalTable + 1)), 0x11));
  // Graphic control extension (4-byte sub-block) and a comment extension (two sub-blocks).
  parts.push(Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00]));
  parts.push(Buffer.from([0x21, 0xfe, 0x03, 0x61, 0x62, 0x63, 0x02, 0x64, 0x65, 0x00]));
  for (const frame of options.frames ?? [{ width, height }]) {
    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    descriptor.writeUInt16LE(frame.left ?? 0, 1);
    descriptor.writeUInt16LE(frame.top ?? 0, 3);
    descriptor.writeUInt16LE(frame.width, 5);
    descriptor.writeUInt16LE(frame.height, 7);
    if (frame.localTable !== undefined) descriptor[9] = 0x80 | frame.localTable;
    parts.push(descriptor);
    if (frame.localTable !== undefined) parts.push(Buffer.alloc(3 * (1 << (frame.localTable + 1)), 0x22));
    // LZW minimum code size 2, one data sub-block, block terminator.
    parts.push(Buffer.from([0x02, 0x02, 0x44, 0x01, 0x00]));
  }
  if (options.trailer !== false) parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

const gifUrl = (buf: Buffer) => `data:image/gif;base64,${buf.toString('base64')}`;
const gif = (width: number, height: number) => gifUrl(gifBytes(width, height));
const gif87 = (width: number, height: number) => gifUrl(gifBytes(width, height, { version: '87a' }));

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

describe('checkImageDataUrl — GIF frames (security-review FILE-V-01)', () => {
  it('accepts a well-formed animated GIF whose frames sit inside the logical screen', () => {
    const buf = gifBytes(512, 512, {
      globalTable: 1,
      frames: [
        { width: 512, height: 512 },
        { left: 100, top: 200, width: 412, height: 312, localTable: 0 },
      ],
    });
    const res = checkImageDataUrl(gifUrl(buf), AVATAR_LIMITS);
    expect(res).toMatchObject({ ok: true, format: 'gif', width: 512, height: 512 });
    expect(readGifStructure(buf)).toEqual({ ok: true, width: 512, height: 512, frames: 2 });
  });

  it('refuses a first frame of 65535×65535 behind a small logical screen (decoder bomb)', () => {
    const bomb = gifUrl(gifBytes(256, 256, { frames: [{ width: 65535, height: 65535 }] }));
    const res = checkImageDataUrl(bomb, AVATAR_LIMITS);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/frame larger than the image/i);
  });

  it('refuses a later frame that is offset past the edge of the screen', () => {
    const shifted = gifUrl(
      gifBytes(512, 512, { frames: [{ width: 512, height: 512 }, { left: 400, top: 0, width: 200, height: 100 }] })
    );
    expect(checkImageDataUrl(shifted, AVATAR_LIMITS).ok).toBe(false);
  });

  it('refuses a truncated GIF: the header alone, a cut data block, a missing trailer', () => {
    const full = gifBytes(512, 512);
    const headerOnly = full.subarray(0, 13);
    const cut = full.subarray(0, full.length - 4);
    const noTrailer = gifBytes(512, 512, { trailer: false });
    for (const buf of [headerOnly, cut, noTrailer]) {
      const res = checkImageDataUrl(gifUrl(buf), AVATAR_LIMITS);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/truncated/i);
    }
  });

  it('refuses malformed structure: an unknown block, no frame at all, a bad LZW code size', () => {
    const full = gifBytes(512, 512);
    // Replace the first extension introducer with a byte that starts no block.
    const unknownBlock = Buffer.from(full);
    unknownBlock[13] = 0x99;
    const noFrames = Buffer.concat([full.subarray(0, 13), Buffer.from([0x3b])]);
    const badLzw = Buffer.from(full);
    badLzw[full.indexOf(0x2c, 13) + 10] = 12;
    for (const buf of [unknownBlock, noFrames, badLzw]) {
      expect(readGifStructure(buf)).toEqual({ ok: false, reason: 'malformed' });
      expect(checkImageDataUrl(gifUrl(buf), AVATAR_LIMITS).ok).toBe(false);
    }
  });

  it('a colour table that runs past the end is truncated, not read out of bounds', () => {
    const buf = gifBytes(512, 512, { globalTable: 7 }).subarray(0, 13 + 100);
    expect(readGifStructure(buf)).toEqual({ ok: false, reason: 'truncated' });
  });

  it('still applies the logical-screen limits to a well-formed GIF', () => {
    expect(checkImageDataUrl(gif(5000, 5000), BANNER_LIMITS).ok).toBe(false);
    expect(checkImageDataUrl(gif(200, 200), AVATAR_LIMITS).ok).toBe(false);
  });

  it('decodeImageDataUrl does not serve a stored GIF with an oversized frame', () => {
    expect(decodeImageDataUrl(gif(512, 512))).toMatchObject({ format: 'gif' });
    expect(decodeImageDataUrl(gifUrl(gifBytes(256, 256, { frames: [{ width: 65535, height: 65535 }] })))).toBeNull();
    expect(decodeImageDataUrl(gifUrl(gifBytes(512, 512).subarray(0, 13)))).toBeNull();
  });
});
