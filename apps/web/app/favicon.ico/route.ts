import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/route';

// D-180 (audit E-14): /favicon.ico answered 404 on every page (browsers and
// crawlers ask for it whatever the page links). The site's icon is
// app/icon.svg, which Next links on every page; this sends the old address
// there. A permanent redirect, so a browser remembers it.
export const GET = withRoute(async (request: Request) => NextResponse.redirect(new URL('/icon.svg', request.url), 308));
