#!/usr/bin/env node
/**
 * Generates the Windows installer artwork from the app icon.
 *
 *   node apps/desktop/scripts/make-installer-assets.mjs
 *
 * Writes, under apps/desktop/src-tauri/installer/:
 *
 *   installer.ico      16–256 px, installer + uninstaller icon (NSIS)
 *   nsis/header.bmp    150×57,  24-bit BMP — header band of every NSIS page
 *   nsis/sidebar.bmp   164×314, 24-bit BMP — welcome/finish pages (/WIZARD)
 *   wix/banner.bmp     493×58,  24-bit BMP — top banner of the MSI dialogs
 *   wix/dialog.bmp     493×312, 24-bit BMP — MSI welcome/finish background
 *
 * The sizes are the ones NSIS (Modern UI 2) and WiX expect; Tauri passes the
 * files through unchanged, so a wrong size shows up stretched or cropped.
 *
 * Colours are LobbyForge's dark theme tokens (apps/web/tailwind.config.ts):
 * surface #111722 behind everything, text-primary #F4F7FB, the ice-blue
 * accent #8FB8FF and the success green #7CCFA6. The NSIS template sets the
 * same surface colour as MUI_BGCOLOR, so the header bitmap must end in that
 * exact colour on its right edge or a seam shows.
 *
 * WiX draws its dialog titles in black on top of the banner and on the right
 * part of the dialog image, so those two keep a white text area and carry the
 * brand on the parts WiX leaves free.
 *
 * sharp is not a dependency of this package: it is already in the workspace
 * through Next (apps/web), so the script borrows it from there instead of
 * adding a second copy to the lockfile. sharp cannot write BMP or ICO, so the
 * encoders for those two formats live at the bottom of this file.
 *
 * The output is committed. Re-run the script after changing the icon or the
 * brand colours; the rendered text depends on the fonts of the machine that
 * runs it (Segoe UI on Windows), so commit what you checked by eye.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, '..');
const repoRoot = join(desktopRoot, '..', '..');
const tauriDir = join(desktopRoot, 'src-tauri');
const outDir = join(tauriDir, 'installer');

const BRAND = {
  surface: '#111722',
  surfaceDeep: '#0D1220',
  surfaceLift: '#1A223B',
  border: '#263142',
  text: '#F4F7FB',
  textSecondary: '#B7C0CC',
  accent: '#8FB8FF',
  success: '#7CCFA6',
  white: '#FFFFFF',
};

const FONT = "'Segoe UI Variable Display', 'Segoe UI', Inter, 'DejaVu Sans', Arial, sans-serif";

async function loadSharp() {
  try {
    return (await import('sharp')).default;
  } catch {
    // Borrow the copy Next brings into the workspace (see header comment).
    const webRequire = createRequire(join(repoRoot, 'apps', 'web', 'package.json'));
    const nextRequire = createRequire(webRequire.resolve('next/package.json'));
    return nextRequire('sharp');
  }
}

const sharp = await loadSharp();
const sourceIcon = readFileSync(join(tauriDir, 'appicon.png')); // 1024×1024 master

/** The icon resized with a proper filter, as a data URI for SVG <image>. */
async function iconDataUri(size) {
  const png = await sharp(sourceIcon).resize(size, size, { kernel: 'lanczos3' }).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

/** Renders an SVG to 24-bit RGB pixels on an opaque background. */
async function renderRgb(svg, width, height, background) {
  const { data, info } = await sharp(Buffer.from(svg), { density: 72 })
    .resize(width, height, { fit: 'fill' })
    .flatten({ background })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.height !== height || info.channels !== 3) {
    throw new Error(`unexpected render ${info.width}x${info.height}x${info.channels}`);
  }
  return data;
}

async function nsisHeader() {
  const w = 150;
  const h = 57;
  const icon = await iconDataUri(34);
  // "LobbyForge" must fit in the 95 px right of the icon with a margin.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <rect width="${w}" height="${h}" fill="${BRAND.surface}"/>
  <image href="${icon}" x="8" y="11" width="34" height="34"/>
  <text x="49" y="32" font-family="${FONT}" font-size="15" font-weight="700" fill="${BRAND.text}" textLength="88" lengthAdjust="spacingAndGlyphs">LobbyForge</text>
  <rect x="50" y="38" width="20" height="3" rx="1.5" fill="${BRAND.success}"/>
</svg>`;
  return { w, h, rgb: await renderRgb(svg, w, h, BRAND.surface) };
}

/** The brand panel shared by the NSIS sidebar and the left of the WiX dialog. */
async function brandPanelSvg(w, h) {
  const iconSize = 88;
  const cx = w / 2;
  const cy = Math.round(h * 0.36);
  const icon = await iconDataUri(iconSize);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${BRAND.surfaceDeep}"/>
      <stop offset="1" stop-color="${BRAND.surfaceLift}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${BRAND.accent}" stop-opacity="0.22"/>
      <stop offset="1" stop-color="${BRAND.accent}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <circle cx="${cx}" cy="${cy}" r="78" fill="url(#glow)"/>
  <image href="${icon}" x="${cx - iconSize / 2}" y="${cy - iconSize / 2}" width="${iconSize}" height="${iconSize}"/>
  <text x="${cx}" y="${cy + iconSize / 2 + 34}" text-anchor="middle" font-family="${FONT}" font-size="21" font-weight="700" fill="${BRAND.text}">LobbyForge</text>
  <rect x="${cx - 18}" y="${cy + iconSize / 2 + 46}" width="36" height="4" rx="2" fill="${BRAND.success}"/>
  <rect x="${w - 1}" y="0" width="1" height="${h}" fill="${BRAND.border}"/>
</svg>`;
}

async function nsisSidebar() {
  const w = 164;
  const h = 314;
  return { w, h, rgb: await renderRgb(await brandPanelSvg(w, h), w, h, BRAND.surface) };
}

async function wixBanner() {
  const w = 493;
  const h = 58;
  const icon = await iconDataUri(42);
  // WiX writes the dialog title and description in black over the left part.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <rect width="${w}" height="${h}" fill="${BRAND.white}"/>
  <image href="${icon}" x="${w - 42 - 10}" y="8" width="42" height="42"/>
</svg>`;
  return { w, h, rgb: await renderRgb(svg, w, h, BRAND.white) };
}

async function wixDialog() {
  const w = 493;
  const h = 312;
  const panelW = 164;
  const panel = await brandPanelSvg(panelW, h);
  const panelPng = await sharp(Buffer.from(panel)).png().toBuffer();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <rect width="${w}" height="${h}" fill="${BRAND.white}"/>
  <image href="data:image/png;base64,${panelPng.toString('base64')}" x="0" y="0" width="${panelW}" height="${h}"/>
</svg>`;
  return { w, h, rgb: await renderRgb(svg, w, h, BRAND.white) };
}

/** 24-bit BI_RGB BMP, bottom-up rows padded to 4 bytes. */
function encodeBmp24({ w, h, rgb }) {
  const rowBytes = Math.ceil((w * 3) / 4) * 4;
  const pixelBytes = rowBytes * h;
  const out = Buffer.alloc(14 + 40 + pixelBytes);
  out.write('BM', 0, 'latin1');
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(14 + 40, 10);
  out.writeUInt32LE(40, 14); // BITMAPINFOHEADER
  out.writeInt32LE(w, 18);
  out.writeInt32LE(h, 22); // positive = bottom-up
  out.writeUInt16LE(1, 26); // planes
  out.writeUInt16LE(24, 28); // bpp
  out.writeUInt32LE(0, 30); // BI_RGB
  out.writeUInt32LE(pixelBytes, 34);
  out.writeInt32LE(3780, 38); // 96 DPI
  out.writeInt32LE(3780, 42);
  for (let y = 0; y < h; y += 1) {
    const dst = 54 + (h - 1 - y) * rowBytes;
    for (let x = 0; x < w; x += 1) {
      const src = (y * w + x) * 3;
      out[dst + x * 3] = rgb[src + 2]; // B
      out[dst + x * 3 + 1] = rgb[src + 1]; // G
      out[dst + x * 3 + 2] = rgb[src]; // R
    }
  }
  return out;
}

/**
 * Multi-size ICO. Sizes up to 64 px are classic 32-bit DIB entries (with an
 * empty AND mask; the alpha channel carries the shape), larger ones are
 * PNG-compressed as Windows Vista and later expect. Every icon consumer
 * (Explorer, NSIS, the taskbar) reads this layout.
 */
async function encodeIco(sizes) {
  const entries = [];
  for (const size of sizes) {
    const resized = sharp(sourceIcon).resize(size, size, { kernel: 'lanczos3' });
    if (size > 64) {
      entries.push({ size, data: await resized.png().toBuffer() });
      continue;
    }
    const { data: rgba } = await resized.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const maskRow = Math.ceil(size / 32) * 4;
    const dib = Buffer.alloc(40 + size * size * 4 + maskRow * size);
    dib.writeUInt32LE(40, 0);
    dib.writeInt32LE(size, 4);
    dib.writeInt32LE(size * 2, 8); // colour rows + mask rows
    dib.writeUInt16LE(1, 12);
    dib.writeUInt16LE(32, 14);
    dib.writeUInt32LE(0, 16);
    dib.writeUInt32LE(size * size * 4 + maskRow * size, 20);
    for (let y = 0; y < size; y += 1) {
      const dst = 40 + (size - 1 - y) * size * 4;
      for (let x = 0; x < size; x += 1) {
        const src = (y * size + x) * 4;
        dib[dst + x * 4] = rgba[src + 2];
        dib[dst + x * 4 + 1] = rgba[src + 1];
        dib[dst + x * 4 + 2] = rgba[src];
        dib[dst + x * 4 + 3] = rgba[src + 3];
      }
    }
    entries.push({ size, data: dib });
  }
  const header = Buffer.alloc(6 + entries.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach((entry, i) => {
    const o = 6 + i * 16;
    header[o] = entry.size >= 256 ? 0 : entry.size;
    header[o + 1] = entry.size >= 256 ? 0 : entry.size;
    header[o + 2] = 0; // palette
    header[o + 3] = 0;
    header.writeUInt16LE(1, o + 4); // planes
    header.writeUInt16LE(32, o + 6); // bpp
    header.writeUInt32LE(entry.data.length, o + 8);
    header.writeUInt32LE(offset, o + 12);
    offset += entry.data.length;
  });
  return Buffer.concat([header, ...entries.map((entry) => entry.data)]);
}

function write(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  console.info(`wrote ${relative(repoRoot, path).replaceAll('\\', '/')} (${data.length} bytes)`);
}

write(join(outDir, 'installer.ico'), await encodeIco([16, 20, 24, 32, 40, 48, 64, 256]));
write(join(outDir, 'nsis', 'header.bmp'), encodeBmp24(await nsisHeader()));
write(join(outDir, 'nsis', 'sidebar.bmp'), encodeBmp24(await nsisSidebar()));
write(join(outDir, 'wix', 'banner.bmp'), encodeBmp24(await wixBanner()));
write(join(outDir, 'wix', 'dialog.bmp'), encodeBmp24(await wixDialog()));
