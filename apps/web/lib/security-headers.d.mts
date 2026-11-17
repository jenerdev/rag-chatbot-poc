// Types for security-headers.mjs (a .mjs because next.config.mjs imports it).
export function supabaseOrigin(supabaseUrl: string | undefined): string | null;
export function contentSecurityPolicy(options?: { supabaseUrl?: string; dev?: boolean }): string;
export function securityHeaders(options?: { supabaseUrl?: string; dev?: boolean }): { key: string; value: string }[];
