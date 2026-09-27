// booking-types-phase1-storage.mjs — the Storage spike (plan/booking-types.md § 2.8, Phase 1).
//
// The question: does Supabase Storage accept the tokens mintTenantToken()
// signs, and do its policies see the same tenant_id / app_admin claims that
// PostgREST does? PostgREST was measured in auth-rls Phase 0. Storage is a
// separate service and has never been asked. If it refuses our tokens, the
// plan stops here: uploading as service_role is not a fallback (CLAUDE.md
// rule 2).
//
// Every refusal has a positive twin (CLAUDE.md trap 12): a refused upload is
// only evidence if an allowed one, by the same client shape, landed. And
// "it was refused" is checked by LISTING the bucket as the service client,
// not by trusting the error, because an upload can error and still land.
//
// The service client here is a TOOL's (plan/ is not apps/ or packages/*/src),
// used only to look, never to do the thing being tested.
//
//   cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/booking-types-phase1-storage.mjs

import { randomUUID } from 'node:crypto';
import { mintTenantToken, scopedClient } from '../packages/db/dist/index.js';
import { asOperator, supabase } from '../packages/db/dist/service.js';

const BUCKET = 'unit-images';

// A real 1×1 PNG, 70 bytes, so the bucket's MIME check sees a real image.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

let failures = 0;
const results = [];
const check = (name, ok, detail) => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}  — ${detail}`);
  if (!ok) failures++;
  console.log(results.at(-1));
};

async function tenant(slug) {
  const { data, error } = await supabase.from('tenants').select('id, slug').eq('slug', slug).single();
  if (error) throw new Error(`No tenant "${slug}": ${error.message}`);
  return data;
}

/** Does this exact object exist? Asked as the service client, which sees everything. */
async function exists(path) {
  const folder = path.slice(0, path.lastIndexOf('/'));
  const file = path.slice(path.lastIndexOf('/') + 1);
  const { data, error } = await supabase.storage.from(BUCKET).list(folder, { search: file });
  if (error) throw new Error(`Could not list ${folder}: ${error.message}`);
  return data.some((o) => o.name === file);
}

async function upload(client, path, body = PNG, contentType = 'image/png') {
  const { error } = await client.storage.from(BUCKET).upload(path, body, { contentType, upsert: false });
  return error ? `${error.statusCode ?? error.status ?? '?'} ${error.message}` : null;
}

const harbor = await tenant('harbor');
const villa = await tenant('villa');
const harborStaff = (await asOperator(harbor)).db;
const villaStaff = (await asOperator(villa)).db;
const harborChat = scopedClient(mintTenantToken({ tenantId: harbor.id }));

const spikePath = (t) => `${t.id}/spike/${randomUUID()}.png`;
const own = spikePath(harbor);

// 1. The positive case everything else leans on.
{
  const error = await upload(harborStaff, own);
  const landed = await exists(own);
  check('harbor staff uploads to its own folder', !error && landed, error ?? `landed at ${own}`);
}

// 2. Public read, with no token at all.
{
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(own);
  const response = await fetch(data.publicUrl);
  const bytes = Buffer.from(await response.arrayBuffer());
  check('the public URL serves it, no token', response.status === 200 && bytes.equals(PNG), `${response.status}, ${bytes.length} bytes, identical: ${bytes.equals(PNG)}`);
}

// 3. Staff of harbor, into villa's folder: wall 2 must refuse.
{
  const path = spikePath(villa);
  const error = await upload(harborStaff, path);
  const landed = await exists(path);
  check("harbor staff cannot upload into villa's folder", Boolean(error) && !landed, `${error ?? 'no error'}; landed: ${landed}`);
}

// 4 and 5. A chat token, own folder and villa's.
for (const [label, path] of [['its own', spikePath(harbor)], ["villa's", spikePath(villa)]]) {
  const error = await upload(harborChat, path);
  const landed = await exists(path);
  check(`a chat token cannot upload into ${label} folder`, Boolean(error) && !landed, `${error ?? 'no error'}; landed: ${landed}`);
}

// 6. The bucket's own MIME wall, reached by a client the policies allow.
{
  const path = `${harbor.id}/spike/${randomUUID()}.svg`;
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const error = await upload(harborStaff, path, svg, 'image/svg+xml');
  const landed = await exists(path);
  check('the bucket refuses SVG, even from staff', Boolean(error) && !landed, `${error ?? 'no error'}; landed: ${landed}`);
}

// 7. The bucket's size wall: 2 MiB + 1 byte, a PNG header then padding.
{
  const path = spikePath(harbor);
  const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024 + 1 - PNG.length)]);
  const error = await upload(harborStaff, path, big);
  const landed = await exists(path);
  check('the bucket refuses a file over 2 MiB', Boolean(error) && !landed, `${error ?? 'no error'}; landed: ${landed}`);
}

// 8. Villa's staff cannot delete harbor's photo.
{
  const { data, error } = await villaStaff.storage.from(BUCKET).remove([own]);
  const still = await exists(own);
  check("villa staff cannot delete harbor's photo", still, `error: ${error?.message ?? 'none'}, removed: ${data?.length ?? 0}; still there: ${still}`);
}

// 9. Harbor's staff can, which is also the cleanup.
{
  const { data, error } = await harborStaff.storage.from(BUCKET).remove([own]);
  const still = await exists(own);
  check('harbor staff deletes its own photo', !error && !still, `error: ${error?.message ?? 'none'}, removed: ${data?.length ?? 0}; still there: ${still}`);
}

console.log(failures === 0 ? '\nALL STORAGE SPIKE CHECKS PASS' : `\n${failures} STORAGE SPIKE CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
