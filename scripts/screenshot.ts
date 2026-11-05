/** Screenshots of the running dashboard. bun scripts/screenshot.ts <name> [url] [--mobile] [--full] */
import { chromium, devices } from "playwright";
const [name = "shot", url = "http://localhost:3000/"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const mobile = process.argv.includes("--mobile");
const full = process.argv.includes("--full");
const browser = await chromium.launch();
const ctx = await browser.newContext(mobile ? { ...devices["iPhone 14 Pro"] } : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors: string[] = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url, { waitUntil: "networkidle" }).catch(() => undefined);
await page.waitForTimeout(Number(process.env.WAIT_MS ?? 3500));
await page.screenshot({ path: `docs/screenshots/${name}.png`, fullPage: full });
console.log(`saved docs/screenshots/${name}.png`, errors.length ? `console errors: ${errors.join(" | ").slice(0, 600)}` : "no console errors");
await browser.close();
