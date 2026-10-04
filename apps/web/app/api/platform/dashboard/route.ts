import { NextResponse } from 'next/server';
import { platformDashboard } from '@rag/pipeline';
import { withPlatformRoute } from '@/lib/platform-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The platform's Pulse strip (D-098): one row per tenant, counts only, from
 * platform_dashboard(), which refuses anyone but a super user itself.
 */
export const GET = withPlatformRoute(async (_request, { platform }) => NextResponse.json(await platformDashboard(platform)));
