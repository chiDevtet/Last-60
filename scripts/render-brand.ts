/**
 * Generates the Asteroid Protocol identity: the vector mark and wordmark lockup (outlined — no font
 * dependency), favicons, app icons, social profile image, X banner and Open Graph image.
 *
 *   bun scripts/render-brand.ts
 *
 * Master artwork lives in `brand/source/` exactly as supplied (raster): `asteroid-mark.webp` (the
 * rendered metal "A" with its burning orbit) and `asteroid-banner.webp`. Large raster assets (app
 * icons, profile image, X banner) are cut from that artwork. Everything that has to stay crisp at
 * small sizes — the header logo, favicons, the brand page — uses a vector redraw of the same mark,
 * traced in the artwork's own 1254 × 1254 coordinate space so the two line up.
 *
 * Concept — "the orbit": a blade-cut metal A (no crossbar: the apex) circled by a burning orbit that
 * threads through the gap in its right leg and ends in a flare. On the website the flare is the
 * moment the round closes; the countdown's final arc burns in the orbit's colours.
 */
import { mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import opentype from "opentype.js";
import { chromium } from "playwright";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "brand");
const SRC = join(OUT, "source");
const PUB = join(ROOT, "apps/web/public");
mkdirSync(join(OUT, "png"), { recursive: true });
mkdirSync(join(PUB, "brand"), { recursive: true });

const bytes = (p: string) => {
  const b = readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const GEIST = realpathSync(join(ROOT, "apps/web/node_modules/geist"));
const geistSemi = join(GEIST, "dist/fonts/geist-sans/Geist-SemiBold.ttf");
const geistMono = join(GEIST, "dist/fonts/geist-mono/GeistMono-Medium.ttf");
// Michroma (SIL OFL 1.1) — the wide geometric face of the supplied wordmark. Outlined below, never shipped as a font.
const MICHROMA = join(dirname(realpathSync(join(ROOT, "node_modules/@fontsource/michroma/package.json"))), "files/michroma-latin-400-normal.woff");
const font = opentype.parse(bytes(MICHROMA));

export const palette = {
  void: "#07080C",
  carbon: "#0D1017",
  graphite: "#141924",
  frost: "#E9EDF5",
  mist: "#8B93A7",
  flare: "#FFB547", // CSS token `signal`
  ember: "#FF7A1A", // CSS token `pulse`
  ink: "#0A0D14",
};

type Theme = {
  metal: [string, string, string];
  shade: number; // darkening of the A's right-hand faces
  bevel: [string, number, string, number]; // inner-edge facets: left (colour, opacity), right (colour, opacity)
  edge: number; // outer-edge highlight opacity
  ring: [string, string, string];
  core: [string, number];
  glow: string | null;
  star: string;
  starGlow: [string, number];
  text: [string, string];
  sub: [string, string];
};
const DARK: Theme = {
  metal: ["#FFFFFF", "#D2D7DE", "#8C949F"],
  shade: 0.16,
  bevel: ["#3F4650", 0.55, "#FFFFFF", 0.32],
  edge: 0.9,
  ring: ["#F0820F", "#FFB23A", "#FFCB63"],
  core: ["#FFF4CC", 0.85],
  glow: "#FF8A1F",
  star: "#FFFFFF",
  starGlow: ["#FFB547", 0.9],
  text: ["#FFFFFF", "#C4CAD3"],
  sub: ["#FFD47E", "#E39A2D"],
};
const LIGHT: Theme = {
  metal: ["#59606B", "#2C323B", "#0D1016"],
  shade: 0.22,
  bevel: ["#000000", 0.35, "#FFFFFF", 0.22],
  edge: 0.25,
  ring: ["#C9560A", "#E07F0C", "#EE9A1A"],
  core: ["#FFD27A", 0.6],
  glow: null,
  star: "#E8860E",
  starGlow: ["#F5A524", 0.45],
  text: ["#1C222B", "#0A0D14"],
  sub: ["#C47C0E", "#A35E08"],
};

const f1 = (n: number) => (Math.round(n * 10) / 10).toString();
type Pt = readonly [number, number];
const poly = (pts: Pt[]) => `M${pts.map(([x, y]) => `${f1(x)} ${f1(y)}`).join("L")}Z`;

// ── the mark, in the artwork's 1254 × 1254 space ────────────────────────────────────────────────
// The A: outer edges meet at (AX, APEX_Y) (the apex is rounded); the inner counter's edges meet at
// (AX, IN_APEX_Y) and end in blade tips. The right leg is cut twice, parallel to the orbit, leaving
// the gap the orbit passes through.
const AX = 662.5;
const APEX_Y = 200;
const TIP_Y = 975;
const HALF = 442.5;
const K = HALF / (TIP_Y - APEX_Y);
const IN_APEX_Y = 415;
const KI = 0.537;
const IN_Y = 828;
const CUT = 0.75;
const APEX_R = 54;
const outerL = (y: number) => AX - K * (y - APEX_Y);
const outerR = (y: number) => AX + K * (y - APEX_Y);
const innerL = (y: number) => AX - KI * (y - IN_APEX_Y);
const innerR = (y: number) => AX + KI * (y - IN_APEX_Y);
/** Where the cut through the right outer edge at `yo` meets the right inner edge. */
function cutInner(yo: number): Pt {
  const xo = outerR(yo);
  const y = (yo - CUT * (AX - KI * IN_APEX_Y - xo)) / (1 + CUT * KI);
  return [innerR(y), y];
}
const alpha = Math.atan(K);
const tanDist = APEX_R / Math.tan(alpha);
const apexL: Pt = [AX - tanDist * Math.sin(alpha), APEX_Y + tanDist * Math.cos(alpha)];
const apexR: Pt = [AX + tanDist * Math.sin(alpha), APEX_Y + tanDist * Math.cos(alpha)];
const tipL: Pt = [AX - HALF, TIP_Y];
const tipR: Pt = [AX + HALF, TIP_Y];
const CUT_HI = 545;
const CUT_LO = 625;

const bodyPath = () =>
  `M${f1(tipL[0])} ${f1(tipL[1])}L${f1(apexL[0])} ${f1(apexL[1])}A${APEX_R} ${APEX_R} 0 0 1 ${f1(apexR[0])} ${f1(apexR[1])}` +
  `L${f1(outerR(CUT_HI))} ${CUT_HI}L${f1(cutInner(CUT_HI)[0])} ${f1(cutInner(CUT_HI)[1])}L${AX} ${IN_APEX_Y}L${f1(innerL(IN_Y))} ${IN_Y}Z`;
const lowerPath = () => poly([cutInner(CUT_LO), [outerR(CUT_LO), CUT_LO], tipR, [innerR(IN_Y), IN_Y]]);

// The orbit: an ellipse fitted to the artwork (centre, semi-axes, tilt), visible from t = −63° round
// the front to t = 260°, with a hand-tuned width profile: hairline ends, widest at the far left.
const ORBIT = { cx: 614.5, cy: 567, a: 504.5, b: 148.9, rot: (-26.37 * Math.PI) / 180, t0: -63, t1: 260 };
const WIDTH: [number, number][] = [[-63, 0], [-52, 5], [-25, 13], [0, 19], [45, 23], [90, 25], [120, 30], [150, 43], [172, 48], [195, 38], [215, 22], [235, 11], [260, 0]];
function orbitWidth(t: number) {
  for (let i = 1; i < WIDTH.length; i++) {
    const [ta, wa] = WIDTH[i - 1]!;
    const [tb, wb] = WIDTH[i]!;
    if (t <= tb) {
      const u = (t - ta) / (tb - ta);
      return wa + (wb - wa) * (u * u * (3 - 2 * u));
    }
  }
  return 0;
}
function orbitPoint(tDeg: number): { p: Pt; n: Pt } {
  const { cx, cy, a, b, rot } = ORBIT;
  const t = (tDeg * Math.PI) / 180;
  const [c, s] = [Math.cos(rot), Math.sin(rot)];
  const lx = a * Math.cos(t);
  const ly = b * Math.sin(t);
  const p: Pt = [cx + lx * c - ly * s, cy + lx * s + ly * c];
  // outward normal of the ellipse in its own frame is (b cos t, a sin t)
  const nx = b * Math.cos(t);
  const ny = a * Math.sin(t);
  const len = Math.hypot(nx, ny);
  return { p, n: [(nx * c - ny * s) / len, (nx * s + ny * c) / len] };
}
/** The orbit as a filled band. `mul` scales its width, `shift` moves it inward (fraction of the width). */
function orbitBand(mul = 1, shift = 0, min = 0) {
  const N = 260;
  const outer: Pt[] = [];
  const inner: Pt[] = [];
  for (let i = 0; i <= N; i++) {
    const t = ORBIT.t0 + ((ORBIT.t1 - ORBIT.t0) * i) / N;
    const w0 = orbitWidth(t);
    const w = w0 > 0 ? Math.max(w0 * mul, Math.min(min, w0 * 6)) : 0;
    const { p, n } = orbitPoint(t);
    const off = -shift * w;
    outer.push([p[0] + n[0] * (w / 2 + off), p[1] + n[1] * (w / 2 + off)]);
    inner.push([p[0] - n[0] * (w / 2 - off), p[1] - n[1] * (w / 2 - off)]);
  }
  return poly([...outer, ...inner.reverse()]);
}
const STAR = orbitPoint(-22).p;

function star(t: Theme, id: string, s = 1, rays = true) {
  const [x, y] = STAR;
  const ray = (len: number, w: number, deg: number) => {
    const r = (deg * Math.PI) / 180;
    const [c, si] = [Math.cos(r), Math.sin(r)];
    const P = (u: number, v: number): Pt => [x + u * c - v * si, y + u * si + v * c];
    return poly([P(-len, 0), P(0, -w), P(len, 0), P(0, w)]);
  };
  return `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(78 * s)}" fill="url(#${id}-sg)"/>
  ${rays ? `<path d="${ray(165 * s, 6.5 * s, 0)}${ray(112 * s, 6 * s, 90)}${ray(46 * s, 4 * s, 45)}${ray(46 * s, 4 * s, -45)}" fill="${t.star}"/>` : ""}
  <circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(12 * s)}" fill="${t.star}"/>`;
}

/**
 * The mark's elements in artwork space. `small` (favicons) thickens the orbit, drops the facets and
 * the flare's rays; `glow` adds the orbit's bloom (dark backgrounds only).
 */
function markBody(t: Theme, id: string, o: { small?: boolean; glow?: boolean } = {}) {
  const small = !!o.small;
  const glow = !!o.glow && !!t.glow;
  const ringMul = small ? 1.9 : 1;
  const ringMin = small ? 26 : 0;
  const leftBevel = poly([[AX, IN_APEX_Y], [innerL(IN_Y), IN_Y], [innerL(IN_Y) - 22, IN_Y], [AX, IN_APEX_Y - 22 / KI]]);
  const hi = cutInner(CUT_HI);
  const rightBevel = poly([[AX, IN_APEX_Y], hi, [hi[0] + 20, hi[1] - 15], [AX, IN_APEX_Y - 20 / KI]]);
  const edge = poly([tipL, apexL, [apexL[0] + 9, apexL[1] + 4], [tipL[0] + 13, tipL[1] - 6]]);
  return `<defs>
    <linearGradient id="${id}-m" gradientUnits="userSpaceOnUse" x1="520" y1="230" x2="760" y2="990">
      <stop offset="0" stop-color="${t.metal[0]}"/><stop offset="0.5" stop-color="${t.metal[1]}"/><stop offset="1" stop-color="${t.metal[2]}"/>
    </linearGradient>
    <linearGradient id="${id}-r" gradientUnits="userSpaceOnUse" x1="130" y1="790" x2="1065" y2="380">
      <stop offset="0" stop-color="${t.ring[0]}"/><stop offset="0.5" stop-color="${t.ring[1]}"/><stop offset="1" stop-color="${t.ring[2]}"/>
    </linearGradient>
    <radialGradient id="${id}-sg" cx="${f1(STAR[0])}" cy="${f1(STAR[1])}" r="${f1(78 * (small ? 1.2 : 1))}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${t.starGlow[0]}" stop-opacity="${t.starGlow[1]}"/><stop offset="0.35" stop-color="${t.starGlow[0]}" stop-opacity="${t.starGlow[1] * 0.35}"/><stop offset="1" stop-color="${t.starGlow[0]}" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="${id}-c"><path d="${bodyPath()}"/><path d="${lowerPath()}"/></clipPath>
    ${glow ? `<filter id="${id}-b" x="-20%" y="-40%" width="140%" height="180%"><feGaussianBlur stdDeviation="16"/></filter>` : ""}
  </defs>
  <path d="${bodyPath()}" fill="url(#${id}-m)"/>
  <path d="${lowerPath()}" fill="url(#${id}-m)"/>
  <g clip-path="url(#${id}-c)">
    <rect x="${AX}" y="150" width="520" height="880" fill="#000" opacity="${t.shade}"/>
    ${small ? "" : `<path d="${leftBevel}" fill="${t.bevel[0]}" opacity="${t.bevel[1]}"/><path d="${rightBevel}" fill="${t.bevel[2]}" opacity="${t.bevel[3]}"/><path d="${edge}" fill="#fff" opacity="${t.edge}"/>`}
  </g>
  ${glow ? `<path d="${orbitBand(1.7)}" fill="${t.glow}" opacity="0.6" filter="url(#${id}-b)"/>` : ""}
  <path d="${orbitBand(ringMul, 0, ringMin)}" fill="url(#${id}-r)"/>
  ${small ? "" : `<path d="${orbitBand(0.36, 0.14)}" fill="${t.core[0]}" opacity="${t.core[1]}"/>`}
  ${star(t, id, small ? 1.25 : 1, !small)}`;
}

// Mark bounds in artwork space (orbit's outer edge to the blade tips; the flare's rays may overhang).
const MARK = { x0: 126, y0: 196, x1: 1106, y1: 976 };

function iconSvg(t: Theme, o: { size?: number; tile?: string; small?: boolean; glow?: boolean; id?: string } = {}) {
  const size = o.size ?? 64;
  const id = o.id ?? "i";
  const cx = (MARK.x0 + MARK.x1) / 2;
  const cy = (MARK.y0 + MARK.y1) / 2 + 6;
  const side = (MARK.x1 - MARK.x0) / (o.tile ? 0.8 : 0.94);
  const vb = `${f1(cx - side / 2)} ${f1(cy - side / 2)} ${f1(side)} ${f1(side)}`;
  const tile = o.tile ? `<rect x="${f1(cx - side / 2)}" y="${f1(cy - side / 2)}" width="${f1(side)}" height="${f1(side)}" rx="${f1(side * 0.22)}" fill="${o.tile}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${vb}" fill="none" role="img" aria-label="Asteroid Protocol">${tile}${markBody(t, id, o)}</svg>`;
}

// ── wordmark ─────────────────────────────────────────────────────────────────────────────────────
/** Outlined text run; returns the path data and the pen position after the last glyph. */
function run(text: string, size: number, x: number, baseline: number, tracking: number) {
  const path = new opentype.Path();
  const glyphs = [...text].map((c) => font.charToGlyph(c)); // no GSUB shaping: opentype.js can't apply all of Michroma's lookups
  glyphs.forEach((g, i) => {
    path.extend(g.getPath(x, baseline, size));
    const next = glyphs[i + 1];
    x += ((g.advanceWidth ?? 0) + (next ? font.getKerningValue(g, next) : 0)) * (size / font.unitsPerEm) + tracking;
  });
  // Glyph contours come back open: a line back to the start point and no Z. Stroked (the emboldening
  // below), an open contour gets butt caps at its start corner and leaves a notch — close every
  // contour properly instead.
  const closed: opentype.PathCommand[] = [];
  let start: { x: number; y: number } | null = null;
  const close = () => {
    const last = closed[closed.length - 1];
    if (!start || !last || last.type === "Z") return;
    if (last.type === "L" && Math.abs(last.x - start.x) < 1e-6 && Math.abs(last.y - start.y) < 1e-6) closed.pop();
    closed.push({ type: "Z" });
  };
  for (const c of path.commands) {
    if (c.type === "M") {
      close();
      start = { x: c.x, y: c.y };
    }
    closed.push(c);
  }
  close();
  path.commands = closed;
  return { path, end: x - tracking };
}
/** The wordmark's A is drawn as Λ — the mark's apex — at Michroma's A proportions. */
function lambda(size: number, x: number, baseline: number) {
  const u = size / font.unitsPerEm;
  const g = font.charToGlyph("A");
  const bb = g.getBoundingBox();
  const cap = 1536;
  const h = 250; // horizontal leg width, font units (≈ the stem width measured across the diagonal)
  const mid = (bb.x1 + bb.x2) / 2;
  const P = (fx: number, fy: number): Pt => [x + fx * u, baseline - fy * u];
  const tanA = (mid - bb.x1) / cap;
  return { d: poly([P(bb.x1, 0), P(mid, cap), P(bb.x2, 0), P(bb.x2 - h, 0), P(mid, cap - h / tanA), P(bb.x1 + h, 0)]), end: x + (g.advanceWidth ?? 0) * u };
}

/**
 * The lockup: mark + ASTEROID over —— PROTOCOL ——, laid out in artwork units so the mark needs no
 * transform. `markless` gives the wordmark alone.
 */
function lockup(t: Theme, id: string, o: { height?: number; glow?: boolean; markless?: boolean } = {}) {
  const CAP = 262; // ASTEROID cap height
  const size = (CAP * font.unitsPerEm) / 1536;
  const bold = size * 0.045; // Michroma has one weight; the supplied wordmark is heavier — embolden by stroking
  const tracking = size * 0.012 + bold * 0.5;
  const subCap = CAP * 0.39;
  const subSize = (subCap * font.unitsPerEm) / 1536;
  const gapV = CAP * 0.44;
  const blockH = CAP + gapV + subCap;
  const midY = (APEX_Y + APEX_R + TIP_Y) / 2;
  const baseline = midY - blockH / 2 + CAP;
  const x0 = o.markless ? 0 : MARK.x1 + CAP * 0.62;

  const lam = lambda(size, x0, baseline);
  const rest = run("STEROID", size, lam.end + tracking, baseline, tracking);
  const wordL = x0 + (font.charToGlyph("A").getBoundingBox().x1 * size) / font.unitsPerEm - bold / 2;
  const wordR = rest.path.getBoundingBox().x2 + bold / 2;
  const wordW = wordR - wordL;

  // PROTOCOL: tracked out to 65 % of the word's width, centred, with rules running to its edges.
  const subBase = baseline + gapV + subCap;
  const natural = run("PROTOCOL", subSize, 0, 0, 0).path.getBoundingBox();
  const subTracking = (wordW * 0.655 - (natural.x2 - natural.x1)) / 7;
  const probe = run("PROTOCOL", subSize, 0, 0, subTracking).path.getBoundingBox();
  const subX = wordL + (wordW - (probe.x2 - probe.x1)) / 2 - probe.x1;
  const sub = run("PROTOCOL", subSize, subX, subBase, subTracking);
  const sb = sub.path.getBoundingBox();
  const ruleGap = subCap * 1.15;
  const ruleH = Math.max(CAP * 0.045, 9);
  const ruleY = subBase - subCap / 2 - ruleH / 2;

  const left = o.markless ? wordL - bold : MARK.x0;
  const right = wordR + bold;
  const top = o.markless ? baseline - CAP - bold : MARK.y0 - 4;
  const bottom = o.markless ? subBase + bold : MARK.y1 + 4;
  const w = right - left;
  const h = bottom - top;
  const height = o.height ?? 120;
  const width = (w / h) * height;
  return {
    width,
    height,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${f1(width)}" height="${height}" viewBox="${f1(left)} ${f1(top)} ${f1(w)} ${f1(h)}" fill="none" role="img" aria-label="Asteroid Protocol">
  <defs>
    <linearGradient id="${id}-t" gradientUnits="userSpaceOnUse" x1="0" y1="${f1(baseline - CAP)}" x2="0" y2="${f1(baseline)}"><stop offset="0" stop-color="${t.text[0]}"/><stop offset="1" stop-color="${t.text[1]}"/></linearGradient>
    <linearGradient id="${id}-s" gradientUnits="userSpaceOnUse" x1="0" y1="${f1(subBase - subCap)}" x2="0" y2="${f1(subBase)}"><stop offset="0" stop-color="${t.sub[0]}"/><stop offset="1" stop-color="${t.sub[1]}"/></linearGradient>
  </defs>
  ${o.markless ? "" : markBody(t, `${id}m`, { glow: o.glow })}
  <path d="${lam.d}${rest.path.toPathData(1)}" fill="url(#${id}-t)" stroke="url(#${id}-t)" stroke-width="${f1(bold)}" stroke-linejoin="round"/>
  <path d="${sub.path.toPathData(1)}" fill="url(#${id}-s)"/>
  <rect x="${f1(wordL)}" y="${f1(ruleY)}" width="${f1(sb.x1 - ruleGap - wordL)}" height="${f1(ruleH)}" fill="url(#${id}-s)"/>
  <rect x="${f1(sb.x2 + ruleGap)}" y="${f1(ruleY)}" width="${f1(wordR - sb.x2 - ruleGap)}" height="${f1(ruleH)}" fill="url(#${id}-s)"/>
</svg>`,
  };
}

const write = (name: string, svg: string, alsoPublic = true) => {
  writeFileSync(join(OUT, name), svg);
  if (alsoPublic) writeFileSync(join(PUB, "brand", name), svg);
};

write("icon-dark.svg", iconSvg(DARK, { glow: true }));
write("icon-light.svg", iconSvg(LIGHT));
write("icon-app.svg", iconSvg(DARK, { tile: palette.void, glow: true }));
write("logo-dark.svg", lockup(DARK, "ld", { glow: true }).svg);
write("logo-light.svg", lockup(LIGHT, "ll").svg);
write("wordmark-dark.svg", lockup(DARK, "wd", { markless: true }).svg);
write("wordmark-light.svg", lockup(LIGHT, "wl", { markless: true }).svg);
// Browser-tab icon: the small-size cut on a tile so it reads on light and dark tab strips.
writeFileSync(join(PUB, "icon.svg"), iconSvg(DARK, { tile: palette.void, small: true }));

// ── raster assets via headless Chromium ───────────────────────────────────────────────────────
const dataUrl = (p: string, type: string) => `data:${type};base64,${readFileSync(p).toString("base64")}`;
const ART = dataUrl(join(SRC, "asteroid-mark.webp"), "image/webp");
const BANNER = dataUrl(join(SRC, "asteroid-banner.webp"), "image/webp");
const page = (w: number, h: number, body: string, bg = palette.void) => `<!doctype html><html><head><style>
  @font-face{font-family:Geist;src:url(${dataUrl(geistSemi, "font/ttf")});}
  @font-face{font-family:GeistMono;src:url(${dataUrl(geistMono, "font/ttf")});}
  html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:${bg};}
  *{box-sizing:border-box}
</style></head><body>${body}</body></html>`;

const banners: { name: string; w: number; h: number; html: string; publicPath?: string }[] = [
  {
    // The supplied banner is already 3:1 — X's banner ratio.
    name: "x-banner.png",
    w: 1500,
    h: 500,
    publicPath: "brand/x-banner.png",
    html: `<img src="${BANNER}" style="display:block;width:1500px;height:500px;object-fit:cover"/>`,
  },
  {
    // Open Graph: the banner, letterboxed into 1.91:1 over a blurred extension of itself, with the tagline.
    name: "og-image.png",
    w: 1200,
    h: 630,
    publicPath: "og-image.png",
    html: `<img src="${BANNER}" style="position:absolute;inset:-60px;width:1320px;height:750px;object-fit:cover;filter:blur(28px) brightness(0.32)"/>
    <img src="${BANNER}" style="position:absolute;left:0;top:18px;width:1200px;height:400px;object-fit:cover;-webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 9%,#000 80%,transparent 100%)"/>
    <div style="position:absolute;left:0;right:0;top:444px;text-align:center">
      <div style="font:600 40px Geist;color:${palette.frost};letter-spacing:-0.01em">The final minute pays.</div>
      <div style="margin-top:16px;font:500 18px GeistMono;color:#AEB5C4;letter-spacing:0.04em">CREATOR FEES → THE LAST 5 BUYERS · EVERY 5 MINUTES · SOLANA</div>
      <div style="margin:22px auto 0;width:120px;height:2px;background:linear-gradient(90deg,transparent,${palette.flare},transparent)"></div>
    </div>`,
  },
  {
    // Profile image: the supplied mark, sized so X's circular crop keeps the orbit and flare.
    name: "social-profile.png",
    w: 400,
    h: 400,
    publicPath: "brand/social-profile.png",
    html: `<div style="position:absolute;inset:0;background:#000"></div><img src="${ART}" style="position:absolute;left:14px;top:20px;width:372px;height:372px"/>`,
  },
];
// App icons come from the supplied artwork; tab-sized favicons use the small vector cut.
const artIcons = [
  { name: "apple-touch-icon.png", size: 180 },
  { name: "icon-192.png", size: 192 },
  { name: "icon-512.png", size: 512 },
];
const favicons = [16, 32, 48];

const browser = await chromium.launch();
const ctx = await browser.newContext({ deviceScaleFactor: 1 });
const p = await ctx.newPage();
for (const b of banners) {
  await p.setViewportSize({ width: b.w, height: b.h });
  await p.setContent(page(b.w, b.h, b.html), { waitUntil: "load" });
  await p.evaluate(() => document.fonts.ready);
  const buf = await p.screenshot({ type: "png" });
  writeFileSync(join(OUT, "png", b.name), buf);
  if (b.publicPath) writeFileSync(join(PUB, b.publicPath), buf);
}
for (const i of artIcons) {
  await p.setViewportSize({ width: i.size, height: i.size });
  await p.setContent(page(i.size, i.size, `<img src="${ART}" style="display:block;width:${i.size}px;height:${i.size}px"/>`, "#000"), { waitUntil: "load" });
  const buf = await p.screenshot({ type: "png" });
  writeFileSync(join(OUT, "png", i.name), buf);
  writeFileSync(join(PUB, i.name), buf);
}
const icoPngs = new Map<number, Buffer>();
for (const s of favicons) {
  await p.setViewportSize({ width: s, height: s });
  await p.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${iconSvg(DARK, { size: s, tile: palette.void, small: true })}</body></html>`);
  const buf = await p.screenshot({ type: "png", omitBackground: true, clip: { x: 0, y: 0, width: s, height: s } });
  writeFileSync(join(OUT, "png", `favicon-${s}.png`), buf);
  icoPngs.set(s, buf);
}
// Logo PNGs for convenience (dark and light backgrounds).
for (const [name, t, bg, glow] of [["logo-dark.png", DARK, palette.void, true], ["logo-light.png", LIGHT, "#FFFFFF", false]] as const) {
  const wm = lockup(t, "lp", { height: 220, glow });
  const w = Math.ceil(wm.width) + 200;
  await p.setViewportSize({ width: w, height: 380 });
  await p.setContent(`<!doctype html><html><body style="margin:0;background:${bg};display:flex;align-items:center;justify-content:center;width:${w}px;height:380px">${wm.svg}</body></html>`);
  writeFileSync(join(OUT, "png", name), await p.screenshot({ type: "png" }));
}
await browser.close();

// favicon.ico with PNG payloads (16, 32, 48).
{
  const sizes = favicons;
  const pngs = sizes.map((s) => icoPngs.get(s)!);
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
console.log("brand assets written to", OUT);
