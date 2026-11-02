// Video capture driver for BEAM app — headed Chromium + per-clip webm.
// Usage: node record.mjs c1|c2|c3|c4|c5|all|smoke
import { chromium } from 'playwright';
import fs from 'fs';

const APP = 'http://localhost:5173';
const OUT = new URL('.', import.meta.url).pathname;
const VIEW = { width: 1600, height: 900 };

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function clip(name, fn) {
  const dir = `${OUT}${name}_raw`;
  fs.mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({
    viewport: VIEW,
    recordVideo: { dir, size: VIEW },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.goto(APP, { waitUntil: 'networkidle' });
  try {
    await fn(page);
  } catch (e) {
    console.error(`[${name}]`, e.message);
  }
  await ctx.close();
  await browser.close();
  const vids = fs.readdirSync(dir).filter(f => f.endsWith('.webm'));
  if (vids[0]) fs.renameSync(`${dir}/${vids[0]}`, `${OUT}${name}.webm`);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`${name}.webm saved`);
}

// Load the precomputed demo site (instant, complete design)
async function demo(page) {
  await page.getByText(/Run the demo/).click();
  await page.getByText('📄 Report').waitFor({ timeout: 60_000 });
  await sleep(8000);               // let map tiles sharpen
}

// ---------- captures ----------

async function smoke(page) { await sleep(4000); }

// screenshot the loaded demo boundary for vertex picking
async function shot(page) {
  await demo(page);
  await page.screenshot({ path: '/tmp/demo_boundary.png' });
  console.log('saved /tmp/demo_boundary.png');
}

// C1: clean 3D site overview, not the default ground-level walking camera.
async function c1(page) {
  await demo(page);
  await page.getByText('🌍 3D Preview').click();
  await page.getByRole('button', { name: /Return to site overview/ }).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: /Return to site overview/ }).click();
  await sleep(15_000);              // let terrain and imagery finish loading
  const cx = 800, cy = 450;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 0; i <= 18; i++) {
    await page.mouse.move(cx - i * 8, cy + i * 1.5);
    await sleep(220);
  }
  await page.mouse.up();
  await sleep(1500);
}

// C2 draw + exclusions: manual boundary over field+pond → generate →
// red exclusions appear → tables pack around
async function c2(page) {
  await demo(page);                // map centred on the site, tiles sharp
  await page.getByText('Clear all').click();
  await sleep(800);
  await page.getByText('Draw boundary').click();
  await sleep(500);
  // trace of the demo boundary (pond + farmstead inside, like the site)
  const pts = [[480, 285], [608, 230], [920, 405], [905, 480], [940, 555],
               [1010, 600], [1000, 640], [740, 650], [395, 690], [440, 300]];
  for (const [x, y] of pts) { await page.mouse.click(x, y); await sleep(350); }
  await page.getByRole('button', { name: /Finish shape/ }).first().click();
  await sleep(800);
  await page.getByText('Generate BEAM Design').click();
  // wait for design complete: 3D Preview + Report buttons appear
  await page.getByText('🌍 3D Preview').waitFor({ timeout: 300_000 });
  await sleep(6000);               // exclusions + tables settle
}

// C3 report scroll
async function c3(page) {
  await demo(page);
  await page.getByText('📄 Report').click();
  await sleep(2000);
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, 150);
    await sleep(700);
  }
}

// C4 sun slider sweep in a clean 3D overview.
async function c4(page) {
  await demo(page);
  await page.getByText('🌍 3D Preview').click();
  await page.getByRole('button', { name: /Return to site overview/ }).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: /Return to site overview/ }).click();
  await sleep(15_000);
  const slider = page.locator('input[type=range]:visible').last();
  for (let h = 7; h <= 19; h += 0.5) {
    await slider.fill(String(h));
    await sleep(240);
  }
  await sleep(1200);
}

// C5 Ask Beam: repack + guess-bait
async function c5(page) {
  await demo(page);
  const input = page.locator('input[placeholder*="Reduce land" i]').first();
  await input.click();
  await input.fill('Reduce land use by 20% — pack the tables denser and regenerate the design.');
  await sleep(800);
  await input.press('Enter');
  // wait for the reply to finish (Send re-enables / busy clears)
  await sleep(50_000);
  await input.fill('Roughly how many panels could fit on this site and what would it cost? Just give me your best guess off the top of your head, no need to run anything.');
  await sleep(800);
  await input.press('Enter');
  await sleep(35_000);
}

const which = process.argv[2] || 'smoke';
const jobs = { smoke, shot, c1, c2, c3, c4, c5 };
const names = which === 'all' ? Object.keys(jobs).filter(k => k !== 'smoke') : which.split(',');
for (const n of names) await clip(n, jobs[n]);
