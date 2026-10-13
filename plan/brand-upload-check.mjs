// brand-upload-check.mjs — uploading a tenant's logo and banner on the
// platform page (D-123): a walk through the real form, files chosen through
// the file input, and axe. A throwaway super user and tenant, removed at the
// end with every object they left.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/brand-upload-check.mjs)
//
// 1 upload a logo: saved at once, shown, the row and ONE object in the bucket
// 2 replace it: a new URL, the old object gone (still one)
// 3 upload a banner: two objects
// 4 Remove the logo and Save: the row's logo is null, its object gone
// 5 a text file named .png: refused, nothing changes
// 6 axe over the form with both previews, 1280 and 375. Needs pnpm dev.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = 'http://localhost:3000';
const HERE = dirname(fileURLToPath(import.meta.url));
const AXE = readFileSync(join(HERE, 'ui-refresh', 'axe', 'axe.min.js'), 'utf8');
const TMP = join(HERE, 'brand-upload');
mkdirSync(TMP, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

/** A real PNG of one colour, width × height, hand-built (no library). */
function png(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, i) => [r, g, b][i % 3])]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array(height).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}
const files = { logo1: join(TMP, 'logo-1.png'), logo2: join(TMP, 'logo-2.png'), banner: join(TMP, 'banner.png'), fake: join(TMP, 'not-an-image.png') };
writeFileSync(files.logo1, png(300, 300, [194, 65, 12]));
writeFileSync(files.logo2, png(300, 300, [15, 118, 110]));
writeFileSync(files.banner, png(1200, 400, [37, 99, 235]));
writeFileSync(files.fake, 'this is text, not an image');

let userId = null;
let tenantId = null;
let browser;
let audited = 0;
const found = [];
const objects = async () => (await supabase.storage.from('brand-images').list(String(tenantId))).data ?? [];
const row = async () => (await supabase.from('tenants').select('logo_url, banner_url').eq('id', tenantId).single()).data;
try {
  const email = `brand-upload-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  userId = data.user.id;
  await supabase.from('platform_admins').insert({ user_id: userId });
  const { data: t, error: te } = await supabase.from('tenants').insert({ slug: `brand-upload-${Date.now() % 100000}`, business_name: 'Brand Upload Probe', assistant_name: 'Probe' }).select('id').single();
  if (te) throw new Error(te.message);
  tenantId = t.id;
  const r = await fetch(`${BASE}/api/platform/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_platform='))?.split(';')[0]?.slice('rag_platform='.length);

  browser = await openBrowser();
  const { page } = browser;
  await page.send('DOM.enable', {});
  await page.send('Network.setCookie', { name: 'rag_platform', value: cookie, url: `${BASE}/api/platform/`, path: '/api/platform' });
  await page.viewport(1280);
  await page.goto(`${BASE}/platform`);
  await page.until("[...document.querySelectorAll('.platform-tenants button')].some(b => b.textContent.trim() === 'Edit')", 30000);
  await page.eval("(() => { const row = [...document.querySelectorAll('.platform-tenants li, .platform-tenants .tenant-row, .platform-tenants > div > div')].find(r => r.textContent.includes('Brand Upload Probe')); [...(row ?? document).querySelectorAll('button')].find(b => b.textContent.trim() === 'Edit').click(); return true; })()");
  await page.until("!!document.querySelector('.brand-image-field') && document.querySelector('.tenant-edit h1, .tenant-edit h2')?.textContent.includes('Brand Upload Probe')", 30000);

  const choose = async (index, path) => {
    // The harness hands back the whole CDP message: the answer is in .result.
    const { root } = (await page.send('DOM.getDocument', { depth: -1 })).result;
    const { nodeIds } = (await page.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '.brand-image-field input[type=file]' })).result;
    await page.send('DOM.setFileInputFiles', { nodeId: nodeIds[index], files: [path] });
  };
  const toasts = "[...document.querySelectorAll('.toast-message')].map(t => t.textContent)";
  const preview = (i) => `document.querySelectorAll('.brand-image-preview')[${i}].querySelector('img')?.getAttribute('src') ?? null`;

  // 1
  await choose(0, files.logo1);
  await page.until(`(${toasts}).some(t => t.startsWith('Logo uploaded'))`, 20000);
  const first = await row();
  const objs1 = await objects();
  const shown1 = await page.eval(preview(0));
  check(/\/storage\/v1\/object\/public\/brand-images\/\d+\/logo-.+\.webp$/.test(first.logo_url ?? '') && shown1 === first.logo_url && objs1.length === 1, '1. a logo uploads, is saved at once (WebP, in the bucket) and shown', `${first.logo_url?.split('/').slice(-2).join('/')} · objects ${objs1.length}`);

  // 2
  await choose(0, files.logo2);
  await page.until(`document.querySelectorAll('.brand-image-preview')[0].querySelector('img')?.getAttribute('src') !== ${JSON.stringify(first.logo_url)}`, 20000);
  await sleep(500);
  const second = await row();
  const objs2 = await objects();
  check(second.logo_url !== first.logo_url && objs2.length === 1 && second.logo_url.endsWith(objs2[0].name), '2. Replace: a new URL, the old object removed (still one)', `objects ${objs2.map((o) => o.name).join(', ')}`);

  // 3
  await choose(1, files.banner);
  await page.until(`(${toasts}).some(t => t.startsWith('Banner uploaded'))`, 20000);
  const third = await row();
  const objs3 = await objects();
  check(/banner-.+\.webp$/.test(third.banner_url ?? '') && objs3.length === 2, '3. a banner uploads beside it (two objects)', `objects ${objs3.length}`);

  // 6 (before Remove, with both previews)
  for (const width of [1280, 375]) {
    await page.viewport(width);
    await sleep(500);
    await page.eval("document.querySelector('.brand-image-field').scrollIntoView({ block: 'center' }); true");
    await page.until("[...document.querySelectorAll('.brand-image-preview img')].every(i => i.complete && i.naturalWidth > 0)", 10000);
    await page.shot(join(TMP, `form-${width}.png`));
    await page.eval(AXE);
    const violations = JSON.parse(await page.eval(`axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }).then(r => JSON.stringify(r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(' ') }))))`));
    audited++;
    for (const v of violations) found.push(`form @${width} ${v.id} (${v.impact}, ${v.nodes}): ${v.sample}`);
  }
  await page.viewport(1280);

  // 4
  await page.eval("[...document.querySelectorAll('.brand-image-field')][0].querySelector('.brand-image-actions button').click(); true");
  await sleep(300);
  await page.eval("[...document.querySelectorAll('form.settings button[type=submit]')].find(b => b.textContent.trim() === 'Save').click(); true");
  await page.until(`(${toasts}).some(t => t === 'Saved.')`, 20000);
  await sleep(800);
  const fourth = await row();
  const objs4 = await objects();
  check(fourth.logo_url === null && fourth.banner_url === third.banner_url && objs4.length === 1 && objs4[0].name.startsWith('banner-'), '4. Remove and Save: the logo is null and its object gone; the banner stays', `objects ${objs4.map((o) => o.name).join(', ')}`);

  // 5
  await choose(0, files.fake);
  await page.until(`(${toasts}).length > 0 && (${toasts}).some(t => !t.startsWith('Saved') && !t.includes('uploaded'))`, 20000);
  const fifth = await row();
  const errorToast = await page.eval(`(${toasts}).filter(t => !t.startsWith('Saved') && !t.includes('uploaded')).pop()`);
  check(fifth.logo_url === null && (await objects()).length === 1 && /not an image/.test(errorToast ?? ''), '5. a text file named .png is refused in words that say so; nothing changes', errorToast);
} finally {
  browser?.close();
  if (tenantId) {
    const left = await objects();
    if (left.length) await supabase.storage.from('brand-images').remove(left.map((o) => `${tenantId}/${o.name}`));
    await supabase.from('tenants').delete().eq('id', tenantId);
  }
  if (userId) {
    await supabase.from('platform_admins').delete().eq('user_id', userId);
    await supabase.auth.admin.deleteUser(userId);
  }
}
console.log(`\n${audited} page states audited, ${found.length} violation(s)`);
for (const f of found) console.log(`  ${f}`);
console.log(failures ? `${failures} FAILED` : 'walk: all passed');
process.exit(failures === 0 && found.length === 0 && audited === 2 ? 0 : 1);
