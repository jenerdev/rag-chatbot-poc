// manage-booking-phase0-spike.mjs — spike (a) of plan/manage-booking.md Phase 0.
//
// The question: can a PRIVATE bucket let a chat token (the guest's route)
// insert a proof under <tenant>/incoming/ and do nothing else — no read, no
// list, no overwrite, no signed URL, nothing in another tenant — while a staff
// token of that tenant can sign a URL that serves the exact bytes? If not,
// § 2.7 changes before Phase 3.
//
// Every refusal has a positive twin (trap 12), and "refused" is checked by
// looking as the service client, never by trusting the error (an upload can
// error and still land; a refused delete is silent, trap 17). The service
// client is a TOOL's here, used only to look and to clean up.
//
// Needs plan/manage-booking-phase0-spike.sql Part A run first.
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/manage-booking-phase0-spike.mjs)

import { randomUUID } from 'node:crypto';
import { mintTenantToken, scopedClient } from '../packages/db/dist/index.js';
import { asOperator, supabase } from '../packages/db/dist/service.js';

const BUCKET = 'payment-proofs-spike';

// A real 1×1 PNG and a minimal PDF, so the bucket's MIME check sees real types.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  — ${detail}`);
};

async function tenant(slug) {
  const { data, error } = await supabase.from('tenants').select('id, slug').eq('slug', slug).single();
  if (error) throw new Error(`No tenant "${slug}": ${error.message}`);
  return data;
}

/** The object's bytes as the service client sees them, or null if it is not there. */
async function stored(path) {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  return error ? null : Buffer.from(await data.arrayBuffer());
}

async function upload(client, path, body = PNG, contentType = 'image/png', upsert = false) {
  const { error } = await client.storage.from(BUCKET).upload(path, body, { contentType, upsert });
  return error ? `${error.statusCode ?? error.status ?? '?'} ${error.message}` : null;
}

const { data: bucket } = await supabase.storage.getBucket(BUCKET);
if (!bucket) throw new Error(`No bucket "${BUCKET}": run Part A of plan/manage-booking-phase0-spike.sql first`);
check('the bucket is private', bucket.public === false, `public: ${bucket.public}, limit ${bucket.file_size_limit}, types ${bucket.allowed_mime_types}`);

const harbor = await tenant('harbor');
const villa = await tenant('villa');
const harborChat = scopedClient(mintTenantToken({ tenantId: harbor.id }));
const harborStaff = (await asOperator(harbor)).db;
const villaStaff = (await asOperator(villa)).db;
const incoming = (t, ext = 'png') => `${t.id}/incoming/${randomUUID()}.${ext}`;

// 1. The positive case everything leans on: a chat token inserts its proof.
const own = incoming(harbor);
{
  const error = await upload(harborChat, own);
  const bytes = await stored(own);
  check('a chat token uploads under its own <tenant>/incoming/', !error && bytes?.equals(PNG), error ?? `landed at ${own}`);
}

// 2–3. Outside incoming/, and in another tenant's incoming/.
for (const [label, path] of [['its own tenant, outside incoming/', `${harbor.id}/other/${randomUUID()}.png`], ["villa's incoming/", incoming(villa)]]) {
  const error = await upload(harborChat, path);
  const bytes = await stored(path);
  check(`a chat token cannot upload into ${label}`, Boolean(error) && !bytes, `${error ?? 'no error'}; landed: ${Boolean(bytes)}`);
}

// 4. A PDF is accepted; an SVG is not (the bucket's MIME wall).
{
  const pdf = incoming(harbor, 'pdf');
  const error = await upload(harborChat, pdf, PDF, 'application/pdf');
  check('a chat token uploads a PDF', !error && Boolean(await stored(pdf)), error ?? 'landed');
  const svg = incoming(harbor, 'svg');
  const svgError = await upload(harborChat, svg, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml');
  check('the bucket refuses SVG', Boolean(svgError) && !(await stored(svg)), svgError ?? 'no error');
}

// 5. The size wall: 5 MiB + 1 byte.
{
  const path = incoming(harbor);
  const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 + 1 - PNG.length)]);
  const error = await upload(harborChat, path, big);
  check('the bucket refuses a file over 5 MiB', Boolean(error) && !(await stored(path)), error ?? 'no error');
}

// 6. A chat token cannot read back, list, sign or overwrite. Each with its
//    positive twin: the staff token CAN list and sign the same object.
{
  const { data: dl, error } = await harborChat.storage.from(BUCKET).download(own);
  check('a chat token cannot download the proof', !dl, error?.message ?? 'no error, but no data');

  const folder = `${harbor.id}/incoming`;
  const chatList = await harborChat.storage.from(BUCKET).list(folder);
  const staffList = await harborStaff.storage.from(BUCKET).list(folder);
  const name = own.split('/').at(-1);
  check('a chat token lists nothing; harbor staff lists the proof',
    (chatList.data ?? []).length === 0 && (staffList.data ?? []).some((o) => o.name === name),
    `chat ${(chatList.data ?? []).length} · staff ${(staffList.data ?? []).length} (${staffList.error?.message ?? 'ok'})`);

  const chatSign = await harborChat.storage.from(BUCKET).createSignedUrl(own, 300);
  check('a chat token cannot sign a URL', !chatSign.data?.signedUrl, chatSign.error?.message ?? 'no error');

  const other = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const overwrite = await upload(harborChat, own, other, 'image/png', true);
  const after = await stored(own);
  check('a chat token cannot overwrite the proof', after?.equals(PNG), `${overwrite ?? 'no error'}; bytes unchanged: ${after?.equals(PNG)}`);
}

// 7. Staff of harbor sign a 5-minute URL that serves the exact bytes, with no token.
{
  const { data, error } = await harborStaff.storage.from(BUCKET).createSignedUrl(own, 300);
  let detail = error?.message ?? 'no url';
  let ok = false;
  if (data?.signedUrl) {
    const response = await fetch(data.signedUrl);
    const bytes = Buffer.from(await response.arrayBuffer());
    ok = response.status === 200 && bytes.equals(PNG);
    detail = `${response.status}, ${bytes.length} bytes, identical: ${bytes.equals(PNG)}`;
  }
  check('harbor staff sign a URL that serves the proof', ok, detail);
}

// 8. Staff of villa cannot sign harbor's proof; the public URL serves nothing.
{
  const { data, error } = await villaStaff.storage.from(BUCKET).createSignedUrl(own, 300);
  check("villa staff cannot sign harbor's proof", !data?.signedUrl, error?.message ?? 'no error');
  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(own);
  const response = await fetch(pub.publicUrl);
  check('the public URL serves nothing (private bucket)', response.status !== 200, `${response.status}`);
}

// Cleanup: every object in the spike bucket, through the API, counted (trap 17).
{
  const paths = [];
  for (const t of [harbor, villa]) {
    for (const sub of ['incoming', 'other']) {
      const { data } = await supabase.storage.from(BUCKET).list(`${t.id}/${sub}`, { limit: 1000 });
      for (const o of data ?? []) paths.push(`${t.id}/${sub}/${o.name}`);
    }
  }
  const { data: removed } = paths.length ? await supabase.storage.from(BUCKET).remove(paths) : { data: [] };
  console.log(`cleanup: ${removed?.length ?? 0} of ${paths.length} objects removed`);
}

console.log(failures ? `\n${failures} SPIKE CHECK(S) FAILED` : '\nALL SPIKE CHECKS PASS');
process.exit(failures ? 1 : 0);
