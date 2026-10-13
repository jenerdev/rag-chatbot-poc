import { NextResponse } from 'next/server';
import { MAX_BRAND_BYTES, uploadBrandImage } from '@rag/pipeline';
import { withPlatformRoute } from '@/lib/platform-auth';
import { badRequest, parseId } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Upload a tenant's logo or banner (D-123): `multipart/form-data` with a
 * `kind` field (logo | banner) and a `file`. The tenant as it now is, its
 * field pointing at the new image; the image it replaced is removed.
 *
 * Through HERE, not from the browser to Storage: the browser holds no token
 * (the platform session is a cookie), and service_role is never used (rule
 * 2). The bytes go up on the platform token, which Storage's policies ask
 * app_is_super() of. Checked here: the declared length, before the body is
 * read; in @rag/pipeline: the real size and the type by its first bytes;
 * in the bucket: size and type again.
 */
export const POST = withPlatformRoute<{ id: string }>(async (request, { platform, params }) => {
  const id = parseId(params.id);
  if (id === null) return badRequest('Invalid tenant id');
  // Multipart adds a boundary and headers, a few hundred bytes; 64 KiB of slack.
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BRAND_BYTES + 64 * 1024) return badRequest(`The image is too large; the limit is ${MAX_BRAND_BYTES / 1048576} MB.`);
  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  const kind = form?.get('kind');
  if (!(file instanceof File) || typeof kind !== 'string') return badRequest('Send "kind" and the image as "file" in multipart/form-data.');
  return NextResponse.json(await uploadBrandImage(platform, id, kind, new Uint8Array(await file.arrayBuffer())));
});
