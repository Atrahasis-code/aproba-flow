import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { ImageResponse } = require('next/og');
const React = require('react');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(WEB_ROOT, 'src', 'app');
const PUBLIC_ICONS_DIR = path.join(WEB_ROOT, 'public', 'icons');

/**
 * Renders the AprobaFlow mark to a PNG Buffer using bundled next/og (Satori + resvg).
 */
async function renderIconPng(size, options = {}) {
  const { square = false, padding = 0 } = options;
  const borderWidth = square ? 0 : Math.max(1, Math.round(size / 64));

  const svg = React.createElement(
    'svg',
    {
      width: '100%',
      height: '100%',
      viewBox: '0 0 64 64',
    },
    React.createElement('path', {
      d: 'M14 46L26 18L32.5 33',
      fill: 'none',
      stroke: '#ffffff',
      strokeWidth: 6,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
    React.createElement('path', {
      d: 'M25.5 39L33 46.5L50 22',
      fill: 'none',
      stroke: '#34d399',
      strokeWidth: 6,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    })
  );

  const element = React.createElement(
    'div',
    {
      style: {
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 50%, #1e3a8a 100%)',
        borderRadius: square ? '0px' : '23%',
        border: borderWidth > 0 ? `${borderWidth}px solid rgba(255, 255, 255, 0.18)` : 'none',
        padding: padding || 0,
      },
    },
    svg
  );

  const response = new ImageResponse(element, { width: size, height: size });
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Packs PNG-encoded icon frames into a standard multi-size Windows/Browser .ico file.
 */
function buildIcoBuffer(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // Reserved
  header.writeUInt16LE(1, 2); // Type 1 = ICO
  header.writeUInt16LE(frames.length, 4);

  const dirEntries = [];
  let offset = 6 + frames.length * 16;

  for (const frame of frames) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(frame.size >= 256 ? 0 : frame.size, 0);
    entry.writeUInt8(frame.size >= 256 ? 0 : frame.size, 1);
    entry.writeUInt8(0, 2); // Color palette count (0 for PNG)
    entry.writeUInt8(0, 3); // Reserved
    entry.writeUInt16LE(1, 4); // Color planes
    entry.writeUInt16LE(32, 6); // Bits per pixel
    entry.writeUInt32LE(frame.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    dirEntries.push(entry);
    offset += frame.data.length;
  }

  return Buffer.concat([header, ...dirEntries, ...frames.map((f) => f.data)]);
}

async function main() {
  await fs.mkdir(APP_DIR, { recursive: true });
  await fs.mkdir(PUBLIC_ICONS_DIR, { recursive: true });

  const [png16, png32, applePng, png192, png512] = await Promise.all([
    renderIconPng(16),
    renderIconPng(32),
    renderIconPng(180, { square: true, padding: '8%' }),
    renderIconPng(192),
    renderIconPng(512),
  ]);

  const icoBuffer = buildIcoBuffer([
    { size: 16, data: png16 },
    { size: 32, data: png32 },
  ]);

  await Promise.all([
    fs.writeFile(path.join(APP_DIR, 'favicon.ico'), icoBuffer),
    fs.writeFile(path.join(APP_DIR, 'apple-icon.png'), applePng),
    fs.writeFile(path.join(PUBLIC_ICONS_DIR, 'icon-192.png'), png192),
    fs.writeFile(path.join(PUBLIC_ICONS_DIR, 'icon-512.png'), png512),
  ]);

  console.log('Generated AprobaFlow icons:', {
    faviconIco: icoBuffer.length,
    appleIconPng: applePng.length,
    icon192Png: png192.length,
    icon512Png: png512.length,
  });
}

main().catch((err) => {
  console.error('Failed to generate icons:', err);
  process.exit(1);
});
