import { notFound } from 'next/navigation';
import { bookingsConfig, listUnits } from '@rag/bookings';
import { CalendarScreen } from '@/components/calendar-screen';
import { hasApplication } from '@/lib/applications';
import { loadBranding } from '@/lib/branding';
import { isView } from '@/lib/calendar-range';
import { loadNavFeatures } from '@/lib/nav';
import { getTenant } from '@/lib/tenant';

// S-12 · Calendar (plan/calendar.md, D-103). Like the other admin pages it
// holds no booking data: the screen calls the calendar route after the
// session check, and the route asks requireAdmin(). A tenant without the
// bookings application gets the ordinary 404.
//
// The view, the date and the room come from the query (?view=week&date=…),
// so a reload or a shared link lands on the same view; the screen keeps the
// address in step as staff move. The room list is names only, for the select.

export const dynamic = 'force-dynamic';

export default async function TenantCalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenant: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const tenant = await getTenant((await params).tenant);
  if (!tenant) notFound();
  if (!(await hasApplication(tenant, 'bookings'))) notFound();

  const [branding, nav, config, units, query] = await Promise.all([
    loadBranding(tenant),
    loadNavFeatures(tenant),
    bookingsConfig(tenant),
    listUnits(tenant).catch(() => []),
    searchParams,
  ]);
  const one = (key: string) => (typeof query[key] === 'string' ? (query[key] as string) : null);
  const view = one('view');
  const date = one('date');
  const unit = Number(one('unit'));

  return (
    <CalendarScreen
      slug={tenant.slug}
      businessName={branding.businessName}
      logoUrl={branding.logoUrl}
      nav={nav}
      perRoom={config?.bookingType === 'per_room'}
      rooms={units.filter((u) => u.active).map((u) => ({ id: u.id, name: u.name }))}
      initial={{
        view: isView(view) ? view : 'month',
        date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
        unit: Number.isInteger(unit) && unit > 0 ? unit : null,
      }}
    />
  );
}
