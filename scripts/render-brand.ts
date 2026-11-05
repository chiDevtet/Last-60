/**
 * Generates the LAST60 identity: vector logos (outlined — no font dependency), favicons, social
 * profile image, X banner and Open Graph image.
 *
 *   bun scripts/render-brand.ts
 *
 * Concept — "the final arc": a five-segment ring, one segment per minute of a round. Only the
 * last segment (the final 60 seconds) is lit and ends in a bright tick at 12 o'clock. The same
 * ring stands in for the "0" of the wordmark, so icon and wordmark are one idea.
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import opentype from "opentype.js";
import { chromium } from "playwright";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "brand");
const PUB = join(ROOT, "apps/web/public");
mkdirSync(join(OUT, "png"), { recursive: true });
mkdirSync(join(PUB, "brand"), { recursive: true });

import { realpathSync } from "node:fs";
const GEIST = realpathSync(join(ROOT, "apps/web/node_modules/geist"));
const fontPath = join(GEIST, "dist/fonts/geist-sans/Geist-Bold.ttf");
const monoPath = join(GEIST, "dist/fonts/geist-mono/GeistMono-Medium.ttf");
const font = opentype.parse(readFileSync(fontPath).buffer);

export const palette = {
  void: "#07080C",
  carbon: "#0D1017",
  graphite: "#141924",
  frost: "#E9EDF5",
  mist: "#8B93A7",
  signal: "#38E1FF",
  pulse: "#7B61FF",
  ink: "#0A0D14",
};

type Theme = { text: string; track: string; a: string; b: string; tick: string };
const DARK: Theme = { text: palette.frost, track: "#283043", a: palette.signal, b: palette.pulse, tick: "#C9F7FF" };
const LIGHT: Theme = { text: palette.ink, track: "#CBD3E1", a: "#0796C7", b: "#5A3FEA", tick: "#0796C7" };

const rad = (deg: number) => ((deg - 90) * Math.PI) / 180;
function arc(cx: number, cy: number, r: number, a0: number, a1: number) {
  const [x0, y0] = [cx + r * Math.cos(rad(a0)), cy + r * Math.sin(rad(a0))];
  const [x1, y1] = [cx + r * Math.cos(rad(a1)), cy + r * Math.sin(rad(a1))];
  return `M${x0.toFixed(3)} ${y0.toFixed(3)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(3)} ${y1.toFixed(3)}`;
}

/** The ring mark. `id` keeps gradient ids unique when several marks share a document. */
function ring(cx: number, cy: number, r: number, stroke: number, t: Theme, id: string, opts: { glow?: boolean } = {}) {
  const gap = 9; // degrees between minute segments (butt caps keep the gaps crisp)
  const segs: string[] = [];
  for (let i = 0; i < 4; i++) segs.push(`<path d="${arc(cx, cy, r, i * 72 + gap / 2, (i + 1) * 72 - gap / 2)}" stroke="${t.track}" stroke-width="${stroke}" stroke-linecap="butt" fill="none"/>`);
  const final = arc(cx, cy, r, 288 + gap / 2, 360 - 0.01);
  const tickR = stroke * 0.62;
  return `
  <defs>
    <linearGradient id="${id}-g" gradientUnits="userSpaceOnUse" x1="${cx - r}" y1="${cy}" x2="${cx}" y2="${cy - r}">
      <stop offset="0" stop-color="${t.b}"/><stop offset="1" stop-color="${t.a}"/>
    </linearGradient>
    ${opts.glow ? `<filter id="${id}-blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${stroke * 0.9}"/></filter>` : ""}
  </defs>
  ${segs.join("\n  ")}
  ${opts.glow ? `<path d="${final}" stroke="url(#${id}-g)" stroke-width="${stroke}" stroke-linecap="butt" fill="none" filter="url(#${id}-blur)" opacity="0.75"/>` : ""}
  <path d="${final}" stroke="url(#${id}-g)" stroke-width="${stroke}" stroke-linecap="butt" fill="none"/>
  <circle cx="${cx}" cy="${cy - r}" r="${tickR}" fill="${t.tick}"/>`;
}

function iconSvg(t: Theme, size = 64, bg?: string) {
  const s = size;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 64 64" fill="none">${bg ? `<rect width="64" height="64" rx="14" fill="${bg}"/>` : ""}${ring(32, 32, 22, 7, t, "m")}</svg>`;
}

/** Wordmark: "LAST6" outlined from Geist Bold + the ring as the final "0". */
function wordmark(t: Theme, height = 120, id = "w") {
  const size = 100;
  const text = "LAST6";
  // Manual layout (per-glyph advance + kerning + slight negative tracking).
  const tracking = -0.012 * size;
  const path = new opentype.Path();
  let x = 0;
  const glyphs = font.stringToGlyphs(text);
  glyphs.forEach((g, i) => {
    const gp = g.getPath(x, 0, size);
    path.extend(gp);
    const next = glyphs[i + 1];
    const kern = next ? font.getKerningValue(g, next) : 0;
    x += ((g.advanceWidth ?? 0) + kern) * (size / font.unitsPerEm) + tracking;
  });
  const bb = path.getBoundingBox();
  const zero = font.charToGlyph("0").getPath(0, 0, size).getBoundingBox();
  const capTop = bb.y1;
  const capH = bb.y2 - bb.y1;
  const advance = x - tracking;
  const stroke = capH * 0.19;
  const r = capH / 2 - stroke / 2;
  const cx = advance + size * 0.06 + r + stroke / 2;
  const cy = capTop + capH / 2;
  const width = cx + r + stroke / 2 + 2;
  void zero;
  const vbY = capTop - 2;
  const vbH = capH + 4;
  const scale = height / vbH;
  return {
    width: width * scale,
    height,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${(width * scale).toFixed(1)}" height="${height}" viewBox="${bb.x1 - 1} ${vbY.toFixed(2)} ${(width - bb.x1 + 1).toFixed(2)} ${vbH.toFixed(2)}" fill="none" role="img" aria-label="LAST60">
  <path d="${path.toPathData(3)}" fill="${t.text}"/>
  ${ring(cx, cy, r, stroke, t, id)}
</svg>`,
  };
}

const write = (name: string, svg: string, alsoPublic = true) => {
  writeFileSync(join(OUT, name), svg);
  if (alsoPublic) writeFileSync(join(PUB, "brand", name), svg);
};

const iconDark = iconSvg(DARK);
const iconLight = iconSvg(LIGHT);
write("icon-dark.svg", iconDark);
write("icon-light.svg", iconLight);
write("icon-app.svg", iconSvg(DARK, 64, palette.carbon));
write("logo-dark.svg", wordmark(DARK).svg);
write("logo-light.svg", wordmark(LIGHT).svg);
writeFileSync(join(PUB, "icon.svg"), iconSvg(DARK, 64, palette.carbon));

// ── raster assets via headless Chromium ───────────────────────────────────────
const page = (w: number, h: number, body: string) => `<!doctype html><html><head><style>
  @font-face{font-family:Geist;src:url(data:font/ttf;base64,${readFileSync(fontPath.replace("Bold", "SemiBold")).toString("base64")});}
  @font-face{font-family:GeistMono;src:url(data:font/ttf;base64,${readFileSync(monoPath).toString("base64")});}
  html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:${palette.void};}
  *{box-sizing:border-box}
</style></head><body>${body}</body></html>`;

const grid = (w: number, h: number) => `<svg width="${w}" height="${h}" style="position:absolute;inset:0" xmlns="http://www.w3.org/2000/svg">
  <defs><pattern id="gp" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#ffffff" stroke-opacity="0.035"/></pattern>
  <radialGradient id="glow" cx="72%" cy="50%" r="55%"><stop offset="0" stop-color="${palette.pulse}" stop-opacity="0.22"/><stop offset="0.45" stop-color="${palette.signal}" stop-opacity="0.06"/><stop offset="1" stop-color="${palette.void}" stop-opacity="0"/></radialGradient></defs>
  <rect width="100%" height="100%" fill="url(#gp)"/><rect width="100%" height="100%" fill="url(#glow)"/></svg>`;

const bigRing = (size: number, id: string) => `<svg width="${size}" height="${size}" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">${ring(100, 100, 78, 12, DARK, id, { glow: true })}</svg>`;

const wmDark = wordmark(DARK, 96, "wm");
const banners: { name: string; w: number; h: number; html: string }[] = [
  {
    name: "x-banner.png",
    w: 1500,
    h: 500,
    html: `${grid(1500, 500)}
    <div style="position:absolute;left:96px;top:150px">${wordmark(DARK, 84, "xb").svg}
      <div style="margin-top:34px;font:600 30px Geist;color:${palette.frost};letter-spacing:-0.01em">The final minute pays.</div>
      <div style="margin-top:12px;font:500 19px GeistMono;color:${palette.mist};letter-spacing:0.02em">CREATOR FEES → THE LAST 5 BUYERS · EVERY 5 MINUTES · SOLANA</div></div>
    <div style="position:absolute;right:70px;top:30px">${bigRing(440, "xr")}</div>`,
  },
  {
    name: "og-image.png",
    w: 1200,
    h: 630,
    html: `${grid(1200, 630)}
    <div style="position:absolute;left:80px;top:205px">${wordmark(DARK, 80, "og").svg}
      <div style="margin-top:32px;font:600 34px Geist;color:${palette.frost};letter-spacing:-0.01em;max-width:560px">Every five minutes, the latest buyers get paid.</div>
      <div style="margin-top:16px;font:500 18px GeistMono;color:${palette.mist}">Verified creator fee allocations · on-chain · verifiable</div></div>
    <div style="position:absolute;right:60px;top:95px">${bigRing(440, "or")}</div>`,
  },
  {
    name: "social-profile.png",
    w: 400,
    h: 400,
    html: `<svg width="400" height="400" style="position:absolute;inset:0"><defs><radialGradient id="pg" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${palette.pulse}" stop-opacity="0.28"/><stop offset="1" stop-color="${palette.void}" stop-opacity="0"/></radialGradient></defs><rect width="400" height="400" fill="url(#pg)"/></svg>
    <div style="position:absolute;left:60px;top:60px">${bigRing(280, "pr")}</div>`,
  },
];
const icons = [
  { name: "apple-touch-icon.png", size: 180, bg: palette.carbon },
  { name: "icon-192.png", size: 192, bg: palette.carbon },
  { name: "icon-512.png", size: 512, bg: palette.carbon },
  { name: "favicon-32.png", size: 32, bg: palette.carbon },
  { name: "favicon-16.png", size: 16, bg: palette.carbon },
  { name: "favicon-48.png", size: 48, bg: palette.carbon },
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ deviceScaleFactor: 1 });
const p = await ctx.newPage();
for (const b of banners) {
  await p.setViewportSize({ width: b.w, height: b.h });
  await p.setContent(page(b.w, b.h, b.html), { waitUntil: "load" });
  await p.evaluate(() => document.fonts.ready);
  const buf = await p.screenshot({ type: "png" });
  writeFileSync(join(OUT, "png", b.name), buf);
  if (b.name === "og-image.png") writeFileSync(join(PUB, "og-image.png"), buf);
}
const icoPngs: Buffer[] = [];
for (const i of icons) {
  await p.setViewportSize({ width: i.size, height: i.size });
  await p.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${iconSvg(DARK, i.size, i.bg).replace('width="' + i.size + '"', `width="${i.size}"`)}</body></html>`);
  const buf = await p.screenshot({ type: "png", omitBackground: true, clip: { x: 0, y: 0, width: i.size, height: i.size } });
  writeFileSync(join(OUT, "png", i.name), buf);
  if (["apple-touch-icon.png", "icon-192.png", "icon-512.png"].includes(i.name)) writeFileSync(join(PUB, i.name), buf);
  if (i.name.startsWith("favicon")) icoPngs.push(buf);
}
// Logo PNGs for convenience (dark and light backgrounds).
for (const [name, t, bg] of [["logo-dark.png", DARK, palette.void], ["logo-light.png", LIGHT, "#FFFFFF"]] as const) {
  const wm = wordmark(t, 160, "lp");
  const w = Math.ceil(wm.width) + 160;
  await p.setViewportSize({ width: w, height: 320 });
  await p.setContent(`<!doctype html><html><body style="margin:0;background:${bg};display:flex;align-items:center;justify-content:center;width:${w}px;height:320px">${wm.svg}</body></html>`);
  writeFileSync(join(OUT, "png", name), await p.screenshot({ type: "png" }));
}
await browser.close();

// favicon.ico with PNG payloads (16, 32, 48).
{
  const sizes = [16, 32, 48];
  const pngs = [icoPngs[1]!, icoPngs[0]!, icoPngs[2]!]; // order matches sizes
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const dir = sizes.map((s, i) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(s === 256 ? 0 : s, 0);
    e.writeUInt8(s === 256 ? 0 : s, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(pngs[i]!.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += pngs[i]!.length;
    return e;
  });
  const ico = Buffer.concat([header, ...dir, ...pngs]);
  writeFileSync(join(OUT, "favicon.ico"), ico);
  writeFileSync(join(ROOT, "apps/web/app/favicon.ico"), ico);
}
void wmDark;
console.log("brand assets written to", OUT);
