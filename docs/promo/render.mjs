#!/usr/bin/env node
// Renders docs/promo/promo.html to docs/media/homeflix-promo.gif and
// docs/media/homeflix-promo-poster.png. See docs/promo/README.md.
//
// Needs, all installed outside this repo: Google Chrome, ffmpeg, and
// puppeteer-core in a scratch directory passed as PROMO_TOOLS.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tools = process.env.PROMO_TOOLS;
if (!tools) { console.error('Set PROMO_TOOLS to a directory where you ran: npm i puppeteer-core'); process.exit(1); }
const puppeteer = createRequire(path.join(path.resolve(tools), 'noop.js'))('puppeteer-core');

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FPS = Number(process.env.FPS || 20);          // 20 fps = an exact 5cs GIF frame delay
const W = 960, H = 540;
const FRAMES_ONLY = process.argv.includes('--frames');   // keep PNG frames, skip encoding
const out = path.resolve(here, '../media');
const frames = process.env.FRAMES_DIR || mkdtempSync(path.join(tmpdir(), 'homeflix-promo-'));
mkdirSync(out, { recursive: true });
mkdirSync(frames, { recursive: true });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--hide-scrollbars', '--force-color-profile=srgb'] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(path.join(here, 'promo.html')).href + '?still');
const dur = await page.evaluate(() => window.DURATION);
const total = Math.round(dur * FPS);
for (let i = 0; i < total; i++) {
  await page.evaluate((t) => window.seek(t), i / FPS);
  await page.screenshot({ path: path.join(frames, `f${String(i).padStart(4, '0')}.png`) });
}
// poster: a dedicated still, at 2x
await page.setViewport({ width: W, height: H, deviceScaleFactor: 2 });
await page.evaluate(() => window.seek('poster'));
await page.screenshot({ path: path.join(out, 'homeflix-promo-poster.png') });
await browser.close();
console.log(`${total} frames in ${frames}`);
if (FRAMES_ONLY) process.exit(0);

const input = ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(frames, 'f%04d.png')];
const pal = path.join(frames, 'palette.png');
execFileSync(FFMPEG, [...input, '-vf', 'palettegen=max_colors=256:stats_mode=diff', pal]);
execFileSync(FFMPEG, [...input, '-i', pal, '-lavfi', 'paletteuse=dither=sierra2_4a:diff_mode=rectangle',
  '-loop', '0', path.join(out, 'homeflix-promo.gif')]);
if (!process.env.FRAMES_DIR) rmSync(frames, { recursive: true, force: true });
console.log('wrote', path.join(out, 'homeflix-promo.gif'));
