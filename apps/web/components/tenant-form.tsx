'use client';

// The tenant form (plan/tenant-management.md § 3.3): one tenant's record,
// for the super user. Create mode takes the three fields a tenant is born
// with (slug, business name, assistant name) and hands the new tenant back;
// edit mode has the rest: names, logo and banner, the five theme colours with
// a live preview, the three fallback messages, the suggested questions
// (D-089), the applications and their config, archive, and the members panel.
//
// Every rule lives elsewhere and is repeated here only to say it FIRST, in
// the form's words: the slug regex and the colour regex (lib/schemas.ts,
// lib/theme.ts) are the same ones zod and Postgres apply. When Postgres
// refuses (a reserved slug, a live booking, the last owner), its sentence is
// shown as it is. The preview is the SAME mechanism the real page uses:
// custom properties through React's `style` prop (D-030), never a <style>.
//
// Since plan/ui-refresh.md Phase 9: under the preview, the colours' contrast
// is checked as they are typed (contrastProblems, lib/theme.ts) and any pair
// below WCAG AA is named; advice, not a refusal. Switching bookings off and
// archiving ask in the dialog.

import { useMemo, useState } from 'react';
import type { TenantDetail } from '@rag/pipeline';
import { describeFailure } from '@/components/admin-login';
import { MembersPanel } from '@/components/members-panel';
import { MAX_SUGGESTED_QUESTION_LENGTH, MAX_SUGGESTED_QUESTIONS } from '@/lib/schemas';
import { COLOUR, THEME_KEY_LIST, THEME_LABELS, contrastProblems, pinsLightScheme, themeVars, type Theme, type ThemeKey } from '@/lib/theme';
import { useConfirmDialog } from '@/components/dialogs';
import { Icon } from '@/components/icons';
import { Tabs } from '@/components/tabs';
import { useNotice } from '@/components/toast';

type Languages = 'english' | 'taglish' | 'tagalog';
const LANGUAGES: Languages[] = ['english', 'taglish', 'tagalog'];
const LANGUAGE_LABELS: Record<Languages, string> = { english: 'English', taglish: 'Taglish', tagalog: 'Tagalog' };

/** The bookings config as the form holds it: strings, emptied = absent (the SQL default). */
interface BookingsFields {
  timezone: string;
  bookingType: 'whole_resort' | 'per_room';
  currency: string;
  weekendDays: string;
  maxStayNights: string;
  maxAdvanceDays: string;
  instructions: string;
  guestHint: string;
}

const asString = (value: unknown) => (typeof value === 'string' ? value : '');
const asNumberString = (value: unknown) => (typeof value === 'number' ? String(value) : '');

function bookingsFieldsOf(config: unknown): BookingsFields {
  const c = (config && typeof config === 'object' ? config : {}) as Record<string, unknown>;
  const page = (c.booking_page && typeof c.booking_page === 'object' ? c.booking_page : {}) as Record<string, unknown>;
  return {
    timezone: asString(c.timezone) || 'Asia/Manila',
    bookingType: c.booking_type === 'per_room' ? 'per_room' : 'whole_resort',
    currency: asString(c.currency),
    weekendDays: Array.isArray(c.weekend_days) ? c.weekend_days.join(',') : '',
    maxStayNights: asNumberString(c.max_stay_nights),
    maxAdvanceDays: asNumberString(c.max_advance_days),
    instructions: asString(page.instructions),
    guestHint: asString(page.guest_hint),
  };
}

/** Back to the config the triggers validate. Absent keys mean the defaults (D-050: whole_resort is the ABSENCE of booking_type). */
function bookingsConfigOf(f: BookingsFields): Record<string, unknown> {
  const config: Record<string, unknown> = { timezone: f.timezone.trim() };
  if (f.bookingType === 'per_room') config.booking_type = 'per_room';
  if (f.currency.trim()) config.currency = f.currency.trim().toUpperCase();
  if (f.weekendDays.trim()) config.weekend_days = f.weekendDays.split(',').map((d) => Number(d.trim())).filter((d) => !Number.isNaN(d));
  if (f.maxStayNights.trim()) config.max_stay_nights = Number(f.maxStayNights);
  if (f.maxAdvanceDays.trim()) config.max_advance_days = Number(f.maxAdvanceDays);
  const page: Record<string, string> = {};
  if (f.instructions.trim()) page.instructions = f.instructions.trim();
  if (f.guestHint.trim()) page.guest_hint = f.guestHint.trim();
  if (Object.keys(page).length) config.booking_page = page;
  return config;
}

function themeOf(value: unknown): Theme {
  const theme: Theme = {};
  if (!value || typeof value !== 'object') return theme;
  for (const key of THEME_KEY_LIST) {
    const v = (value as Record<string, unknown>)[key];
    if (typeof v === 'string') theme[key] = v;
  }
  return theme;
}

function fallbacksOf(value: unknown): Record<Languages, string> {
  const out = { english: '', taglish: '', tagalog: '' };
  if (!value || typeof value !== 'object') return out;
  for (const l of LANGUAGES) out[l] = asString((value as Record<string, unknown>)[l]);
  return out;
}

/** Always MAX_SUGGESTED_QUESTIONS fields; the empty ones are dropped on save. */
function suggestionsOf(value: unknown): string[] {
  const saved = Array.isArray(value) ? value.filter((q): q is string => typeof q === 'string') : [];
  return Array.from({ length: MAX_SUGGESTED_QUESTIONS }, (_, i) => saved[i] ?? '');
}

export function TenantForm({
  api,
  tenant,
  selfUserId,
  onSaved,
  onUnauthorized,
}: {
  api: string;
  /** null = create mode. */
  tenant: TenantDetail | null;
  selfUserId: string | null;
  onSaved: (tenant: TenantDetail) => void;
  onUnauthorized: () => void;
}) {
  // Creating, the form is the whole page: its refusal stays under it, beside
  // the slug that is usually the cause. Editing, every message is a toast.
  const { notice, setNotice } = useNotice(!tenant);
  const [busy, setBusy] = useState(false);

  const [slug, setSlug] = useState('');
  const [businessName, setBusinessName] = useState(tenant?.businessName ?? '');
  const [assistantName, setAssistantName] = useState(tenant?.assistantName ?? '');
  const [logoUrl, setLogoUrl] = useState(tenant?.logoUrl ?? '');
  const [bannerUrl, setBannerUrl] = useState(tenant?.bannerUrl ?? '');
  const [theme, setTheme] = useState<Theme>(themeOf(tenant?.theme));
  const [fallbacks, setFallbacks] = useState(fallbacksOf(tenant?.fallbackMessages));
  const [suggestions, setSuggestions] = useState<string[]>(suggestionsOf(tenant?.suggestedQuestions));
  const [bookings, setBookings] = useState<BookingsFields>(bookingsFieldsOf(tenant?.applicationConfigs.bookings));

  const bookingsOn = tenant?.applications.includes('bookings') ?? false;
  const badColours = useMemo(() => THEME_KEY_LIST.filter((k) => theme[k] && !COLOUR.test(theme[k]!)), [theme]);
  const preview = useMemo(() => themeVars(theme), [theme]);
  const contrast = useMemo(() => contrastProblems(theme), [theme]);
  const { ask, dialog } = useConfirmDialog();

  /** One request; the tenant the route hands back becomes the form's tenant. */
  async function send(method: string, path: string, body: object | undefined, done: string) {
    setBusy(true);
    setNotice(null);
    let response: Response | null = null;
    try {
      response = await fetch(`${api}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (response.status === 401) return onUnauthorized();
      if (!response.ok) throw new Error('failed');
      const saved: TenantDetail = await response.json();
      // Said even on create: the toast outlives this form, which the platform
      // replaces with the new tenant's.
      setNotice({ message: done, kind: 'ok' });
      onSaved(saved);
    } catch (error) {
      setNotice({ message: await describeFailure(error as Error, response), kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  if (!tenant) {
    return (
      <section className="card">
        <h2>New tenant</h2>
        <p className="small muted">
          The slug is the address, <code>/t/&lt;slug&gt;</code>, and cannot change later. Everything else is edited after
          saving.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void send('POST', '/tenants', { slug: slug.trim(), businessName: businessName.trim(), assistantName: assistantName.trim() }, 'Created.');
          }}
        >
          <div className="field">
            <label htmlFor="tenant-slug">Slug</label>
            <input id="tenant-slug" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="harbor-inn" pattern="[a-z0-9][a-z0-9-]{1,30}[a-z0-9]" required autoFocus />
            <span className="small muted">3–32 lower-case letters, digits and hyphens.</span>
          </div>
          <div className="field">
            <label htmlFor="tenant-business">Business name</label>
            <input id="tenant-business" value={businessName} onChange={(e) => setBusinessName(e.target.value)} maxLength={100} required />
          </div>
          <div className="field">
            <label htmlFor="tenant-assistant">Assistant name</label>
            <input id="tenant-assistant" value={assistantName} onChange={(e) => setAssistantName(e.target.value)} maxLength={50} required />
          </div>
          {notice && (
            <div className="notice error" role="alert">
              {notice.message}
            </div>
          )}
          <div className="form-footer">
            <span className="small muted">A new tenant has no members and no applications yet.</span>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Creating…' : 'Create tenant'}
            </button>
          </div>
        </form>
      </section>
    );
  }

  const id = tenant.id;
  // Four tabs (plan/ui-components.md Phase 5): the page was one long stack of
  // five cards. Profile is the ONE form with its ONE Save, all in one tab,
  // so a Save never posts fields from a panel nobody can see (trap 6).
  const profile = (
    <section className="card">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (badColours.length) return setNotice({ message: `${badColours.map((k) => THEME_LABELS[k]).join(', ')}: a colour is #rgb or #rrggbb.`, kind: 'error' });
          const themeOut: Theme = {};
          for (const k of THEME_KEY_LIST) if (theme[k]) themeOut[k] = theme[k];
          const fb: Partial<Record<Languages, string>> = {};
          for (const l of LANGUAGES) if (fallbacks[l].trim()) fb[l] = fallbacks[l].trim();
          const questions = suggestions.map((q) => q.trim()).filter(Boolean);
          void send(
            'PATCH',
            `/tenants/${id}`,
            {
              businessName: businessName.trim(),
              assistantName: assistantName.trim(),
              logoUrl: logoUrl.trim() || null,
              bannerUrl: bannerUrl.trim() || null,
              theme: themeOut,
              fallbackMessages: Object.keys(fb).length ? fb : null,
              suggestedQuestions: questions.length ? questions : null,
            },
            'Saved.',
          );
        }}
      >
        <div className="field-row">
          <div className="field">
            <label htmlFor="tenant-business">Business name</label>
            <input id="tenant-business" value={businessName} onChange={(e) => setBusinessName(e.target.value)} maxLength={100} required />
          </div>
          <div className="field">
            <label htmlFor="tenant-assistant">Assistant name</label>
            <input id="tenant-assistant" value={assistantName} onChange={(e) => setAssistantName(e.target.value)} maxLength={50} required />
          </div>
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="tenant-logo">Logo URL (https)</label>
            <input id="tenant-logo" type="url" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="https://…" />
          </div>
          <div className="field">
            <label htmlFor="tenant-banner">Banner URL (https)</label>
            <input id="tenant-banner" type="url" value={bannerUrl} onChange={(e) => setBannerUrl(e.target.value)} placeholder="https://…" />
          </div>
        </div>

        <h3>Theme</h3>
        <p className="small muted">Five colours, #rgb or #rrggbb. An emptied field is the default look.</p>
        <div className="field-row">
          {THEME_KEY_LIST.map((key: ThemeKey) => (
            <div className="field" key={key}>
              <label htmlFor={`theme-${key}`}>{THEME_LABELS[key]}</label>
              <input
                id={`theme-${key}`}
                value={theme[key] ?? ''}
                placeholder="#0f766e"
                onChange={(e) => setTheme({ ...theme, [key]: e.target.value })}
                aria-invalid={badColours.includes(key)}
              />
            </div>
          ))}
        </div>
        {/* The preview: the real page's mechanism, custom properties through `style`, and nothing else. */}
        <div className="tenant-root tenant-preview" data-scheme={pinsLightScheme(preview) ? 'light' : undefined} style={preview}>
          <div className="card">
            <div className="turn user">
              <div className="bubble">Is the pool open on Sundays?</div>
            </div>
            <p className="small">
              <strong>{assistantName || 'Assistant'}:</strong> Yes, from 8 AM to 6 PM.
            </p>
            <button type="button" className="primary">
              Book
            </button>{' '}
            <button type="button">Sample</button>
          </div>
        </div>
        {contrast.length > 0 ? (
          <div className="notice warn" role="status">
            <strong>Hard to read:</strong>
            <ul className="contrast-list">
              {contrast.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="hint met" role="status">
            <Icon name="check" size={14} /> Every text colour passes the 4.5:1 contrast check.
          </p>
        )}

        <h3>When the documents cannot answer</h3>
        <p className="small muted">What the chat says instead, per reply language. Empty = the built-in default (D-047, D-048).</p>
        {LANGUAGES.map((l) => (
          <div className="field" key={l}>
            <label htmlFor={`fallback-${l}`}>{LANGUAGE_LABELS[l]}</label>
            <textarea id={`fallback-${l}`} rows={2} maxLength={500} value={fallbacks[l]} onChange={(e) => setFallbacks({ ...fallbacks, [l]: e.target.value })} />
          </div>
        ))}

        <h3>Suggested questions</h3>
        <p className="small muted">
          Shown as buttons on a new, empty chat; a click asks the question at once. Up to {MAX_SUGGESTED_QUESTIONS}, each at
          most {MAX_SUGGESTED_QUESTION_LENGTH} characters, in this order. Empty = none (D-089).
        </p>
        {suggestions.map((q, i) => (
          <div className="field" key={i}>
            <label htmlFor={`suggestion-${i}`}>Question {i + 1}</label>
            <input
              id={`suggestion-${i}`}
              value={q}
              maxLength={MAX_SUGGESTED_QUESTION_LENGTH}
              placeholder={i === 0 ? 'What rooms do you have?' : ''}
              onChange={(e) => setSuggestions(suggestions.map((s, j) => (j === i ? e.target.value : s)))}
            />
          </div>
        ))}

        <div className="form-footer">
          <span className="small muted">
            {tenant.archivedAt ? `Archived since ${new Date(tenant.archivedAt).toLocaleString()}.` : 'Live.'}
          </span>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </section>
  );

  const applications = (
    <section className="card">
      <h2>Applications</h2>
      <p className="small muted">
        Bookings gives the tenant a bookings screen, the <code>check_availability</code> tool and, once a unit has a rate,
        the public booking page. Switching it off is refused while a booking has not ended; the rooms and bookings stay.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send('PUT', `/tenants/${id}/applications/bookings`, { config: bookingsConfigOf(bookings) }, bookingsOn ? 'Bookings config saved.' : 'Bookings switched on.');
        }}
      >
        <div className="field-row">
          <div className="field">
            <label htmlFor="bk-tz">Timezone</label>
            <input id="bk-tz" value={bookings.timezone} onChange={(e) => setBookings({ ...bookings, timezone: e.target.value })} required />
          </div>
          <div className="field">
            <label htmlFor="bk-type">Books as</label>
            <select id="bk-type" value={bookings.bookingType} onChange={(e) => setBookings({ ...bookings, bookingType: e.target.value as BookingsFields['bookingType'] })}>
              <option value="whole_resort">Whole resort (one property)</option>
              <option value="per_room">Per room</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="bk-currency">Currency</label>
            <input id="bk-currency" value={bookings.currency} onChange={(e) => setBookings({ ...bookings, currency: e.target.value })} placeholder="PHP" maxLength={3} />
          </div>
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="bk-weekend">Weekend days (ISO, 1–7)</label>
            <input id="bk-weekend" value={bookings.weekendDays} onChange={(e) => setBookings({ ...bookings, weekendDays: e.target.value })} placeholder="6,7" />
          </div>
          <div className="field">
            <label htmlFor="bk-nights">Max stay, nights</label>
            <input id="bk-nights" type="number" min={1} max={60} value={bookings.maxStayNights} onChange={(e) => setBookings({ ...bookings, maxStayNights: e.target.value })} placeholder="14" />
          </div>
          <div className="field">
            <label htmlFor="bk-days">Booking horizon, days</label>
            <input id="bk-days" type="number" min={1} max={730} value={bookings.maxAdvanceDays} onChange={(e) => setBookings({ ...bookings, maxAdvanceDays: e.target.value })} placeholder="365" />
          </div>
        </div>
        <div className="field">
          <label htmlFor="bk-instructions">Booking page: what a customer reads after sending a request</label>
          <textarea id="bk-instructions" rows={3} maxLength={2000} value={bookings.instructions} onChange={(e) => setBookings({ ...bookings, instructions: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="bk-hint">Booking page: hint by the guest count</label>
          <input id="bk-hint" maxLength={200} value={bookings.guestHint} onChange={(e) => setBookings({ ...bookings, guestHint: e.target.value })} />
        </div>
        <div className="form-footer">
          <span className="small muted">
            {bookingsOn ? 'Bookings is on.' : 'Bookings is off.'} Slots, rooms and rates are set on the tenant&apos;s own screens or by script.
          </span>
          <span>
            {bookingsOn && (
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  const sure = await ask({
                    title: 'Switch bookings off?',
                    body: 'Refused while a booking has not ended. Rooms and bookings stay, and switching it on again brings them back.',
                    actionLabel: 'Switch off',
                  });
                  if (sure !== null) void send('DELETE', `/tenants/${id}/applications/bookings`, undefined, 'Bookings switched off.');
                }}
              >
                Switch off
              </button>
            )}{' '}
            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Saving…' : bookingsOn ? 'Save config' : 'Switch on'}
            </button>
          </span>
        </div>
      </form>
    </section>
  );

  const archive = (
    <section className="card">
      <h2>{tenant.archivedAt ? 'Archived' : 'Archive'}</h2>
      <p className="small muted">
        Archived, the tenant answers 404 everywhere: its chat, its admin, its booking page. Nothing is deleted, and this
        can be undone. Deleting for good is a command-line step (<code>tenant:remove</code>), because it takes guest
        data and documents with it.
      </p>
      <div className="form-footer">
        <span />
        {tenant.archivedAt ? (
          <button type="button" className="primary" disabled={busy} onClick={() => void send('DELETE', `/tenants/${id}/archive`, undefined, 'Unarchived: the tenant resolves again.')}>
            Unarchive
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              const sure = await ask({
                title: `Archive ${tenant.businessName}?`,
                body: 'Its chat, admin and booking pages will answer 404 until it is unarchived. Nothing is deleted.',
                actionLabel: 'Archive',
                danger: true,
              });
              if (sure !== null) void send('POST', `/tenants/${id}/archive`, undefined, 'Archived: the tenant answers 404 everywhere.');
            }}
          >
            Archive
          </button>
        )}
      </div>
    </section>
  );

  return (
    <>
      {dialog}
      <h2 className="tenant-head">
        {tenant.businessName} <span className="small muted">/t/{tenant.slug}</span>
      </h2>
      <Tabs
        label={`${tenant.businessName} settings`}
        tabs={[
          { id: 'profile', label: 'Profile', panel: profile },
          { id: 'applications', label: 'Applications', panel: applications },
          { id: 'members', label: 'Members', panel: <MembersPanel api={`${api}/tenants/${id}/members`} selfUserId={selfUserId} onUnauthorized={onUnauthorized} /> },
          { id: 'archive', label: tenant.archivedAt ? 'Archived' : 'Archive', panel: archive },
        ]}
      />
    </>
  );
}
