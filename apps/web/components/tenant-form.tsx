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
import { BrandImageField } from '@/components/brand-image-field';
import { FeaturesPanel } from '@/components/features-panel';
import { MembersPanel } from '@/components/members-panel';
import { MAX_SUGGESTED_QUESTION_LENGTH, MAX_SUGGESTED_QUESTIONS } from '@/lib/schemas';
import { COLOUR, THEME_KEY_LIST, THEME_LABELS, contrastProblems, pinsLightScheme, themeVars, type Theme, type ThemeKey } from '@/lib/theme';
import { useConfirmDialog } from '@/components/dialogs';
import { Icon } from '@/components/icons';
import { Tabs } from '@/components/tabs';
import { TenantMark } from '@/components/tenant-mark';
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

/** ISO weekdays, as the config stores them: 1 = Monday … 7 = Sunday. */
const ISO_DAYS = [
  [1, 'Mon', 'Monday'],
  [2, 'Tue', 'Tuesday'],
  [3, 'Wed', 'Wednesday'],
  [4, 'Thu', 'Thursday'],
  [5, 'Fri', 'Friday'],
  [6, 'Sat', 'Saturday'],
  [7, 'Sun', 'Sunday'],
] as const;

/** "5,6,7" → [5, 6, 7]: the form keeps the field a string, as before. */
function weekendOf(value: string): number[] {
  return value
    .split(',')
    .map((d) => Number(d.trim()))
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
}

/** #rgb or #rrggbb → #rrggbb for the colour picker; anything else → null. */
function hex6(value: string | undefined): string | null {
  if (!value) return null;
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(value)) return `#${[...value.slice(1)].map((c) => c + c).join('')}`.toLowerCase();
  return null;
}

interface ProfileFields {
  businessName: string;
  assistantName: string;
  logoUrl: string;
  bannerUrl: string;
  avatarUrl: string;
  theme: Theme;
  fallbacks: Record<Languages, string>;
  suggestions: string[];
}

function profileFieldsOf(tenant: TenantDetail): ProfileFields {
  return {
    businessName: tenant.businessName,
    assistantName: tenant.assistantName,
    logoUrl: tenant.logoUrl ?? '',
    bannerUrl: tenant.bannerUrl ?? '',
    avatarUrl: tenant.assistantAvatarUrl ?? '',
    theme: themeOf(tenant.theme),
    fallbacks: fallbacksOf(tenant.fallbackMessages),
    suggestions: suggestionsOf(tenant.suggestedQuestions),
  };
}

/** The PATCH body: the same eight keys every time. Also what "unsaved" compares. */
function profileBodyOf(f: ProfileFields) {
  const theme: Theme = {};
  for (const k of THEME_KEY_LIST) if (f.theme[k]) theme[k] = f.theme[k];
  const fb: Partial<Record<Languages, string>> = {};
  for (const l of LANGUAGES) if (f.fallbacks[l].trim()) fb[l] = f.fallbacks[l].trim();
  const questions = f.suggestions.map((q) => q.trim()).filter(Boolean);
  return {
    businessName: f.businessName.trim(),
    assistantName: f.assistantName.trim(),
    logoUrl: f.logoUrl.trim() || null,
    bannerUrl: f.bannerUrl.trim() || null,
    assistantAvatarUrl: f.avatarUrl.trim() || null,
    theme,
    fallbackMessages: Object.keys(fb).length ? fb : null,
    suggestedQuestions: questions.length ? questions : null,
  };
}

export function TenantForm({
  api,
  tenant,
  selfUserId,
  onSaved,
  onUnauthorized,
  onCancel,
  onBack,
}: {
  api: string;
  /** null = create mode. */
  tenant: TenantDetail | null;
  selfUserId: string | null;
  onSaved: (tenant: TenantDetail) => void;
  onUnauthorized: () => void;
  /** Create mode: the drawer's Cancel. */
  onCancel?: () => void;
  /** Edit mode: back to the tenant list. */
  onBack?: () => void;
}) {
  // Creating, the form is a drawer: its refusal stays in it, beside the slug
  // that is usually the cause. Editing, every message is a toast.
  const { notice, setNotice } = useNotice(!tenant);
  const [busy, setBusy] = useState(false);

  const [slug, setSlug] = useState('');
  const [businessName, setBusinessName] = useState(tenant?.businessName ?? '');
  const [assistantName, setAssistantName] = useState(tenant?.assistantName ?? '');
  const [logoUrl, setLogoUrl] = useState(tenant?.logoUrl ?? '');
  const [bannerUrl, setBannerUrl] = useState(tenant?.bannerUrl ?? '');
  const [avatarUrl, setAvatarUrl] = useState(tenant?.assistantAvatarUrl ?? '');
  const [theme, setTheme] = useState<Theme>(themeOf(tenant?.theme));
  const [fallbacks, setFallbacks] = useState(fallbacksOf(tenant?.fallbackMessages));
  const [suggestions, setSuggestions] = useState<string[]>(suggestionsOf(tenant?.suggestedQuestions));
  const [bookings, setBookings] = useState<BookingsFields>(bookingsFieldsOf(tenant?.applicationConfigs.bookings));

  const bookingsOn = tenant?.applications.includes('bookings') ?? false;
  const badColours = useMemo(() => THEME_KEY_LIST.filter((k) => theme[k] && !COLOUR.test(theme[k]!)), [theme]);
  const preview = useMemo(() => themeVars(theme), [theme]);
  const contrast = useMemo(() => contrastProblems(theme), [theme]);
  const { ask, dialog } = useConfirmDialog();
  const profileFields: ProfileFields = { businessName, assistantName, logoUrl, bannerUrl, avatarUrl, theme, fallbacks, suggestions };

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

  // Creating, the form is the platform's drawer (platform-screen.tsx): its
  // title is the drawer's, so the form brings no card and no heading.
  if (!tenant) {
    return (
      <form
        className="setup-form"
        onSubmit={(event) => {
          event.preventDefault();
          void send('POST', '/tenants', { slug: slug.trim(), businessName: businessName.trim(), assistantName: assistantName.trim() }, 'Created.');
        }}
      >
        <p className="small muted setup-intro">
          The slug is the address, <code>/t/&lt;slug&gt;</code>, and cannot change later. Everything else is edited after
          saving.
        </p>
        <div className="field">
          <label htmlFor="tenant-slug">Slug</label>
          <input id="tenant-slug" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="harbor-inn" pattern="[a-z0-9][a-z0-9-]{1,30}[a-z0-9]" required autoComplete="off" />
          <p className="hint small muted">3–32 lower-case letters, digits and hyphens.</p>
        </div>
        <div className="field">
          <label htmlFor="tenant-business">Business name</label>
          <input id="tenant-business" value={businessName} onChange={(e) => setBusinessName(e.target.value)} maxLength={100} required autoComplete="off" />
        </div>
        <div className="field">
          <label htmlFor="tenant-assistant">Assistant name</label>
          <input id="tenant-assistant" value={assistantName} onChange={(e) => setAssistantName(e.target.value)} maxLength={50} required autoComplete="off" />
        </div>
        {notice && (
          <div className="notice error drawer-notice" role="alert">
            {notice.message}
          </div>
        )}
        <div className="drawer-footer">
          <div className="drawer-footer-total">
            <span className="small muted">A new tenant has no members and no applications yet.</span>
          </div>
          {onCancel && (
            <button type="button" disabled={busy} onClick={onCancel}>
              Cancel
            </button>
          )}
          <button type="submit" className="primary" aria-busy={busy || undefined} disabled={busy}>
            {busy ? 'Creating…' : 'Create tenant'}
          </button>
        </div>
      </form>
    );
  }

  const id = tenant.id;
  const saved = profileFieldsOf(tenant);
  const profileDirty = JSON.stringify(profileBodyOf(profileFields)) !== JSON.stringify(profileBodyOf(saved));
  const savedBookings = bookingsFieldsOf(tenant.applicationConfigs.bookings);
  const bookingsDirty = !bookingsOn || JSON.stringify(bookingsConfigOf(bookings)) !== JSON.stringify(bookingsConfigOf(savedBookings));
  const weekend = weekendOf(bookings.weekendDays);

  function discardProfile() {
    setBusinessName(saved.businessName);
    setAssistantName(saved.assistantName);
    setLogoUrl(saved.logoUrl);
    setBannerUrl(saved.bannerUrl);
    setAvatarUrl(saved.avatarUrl);
    setTheme(saved.theme);
    setFallbacks(saved.fallbacks);
    setSuggestions(saved.suggestions);
  }

  // Four tabs (plan/ui-components.md Phase 5). Profile is the ONE form with
  // its ONE Save, all in one tab, so a Save never posts fields from a panel
  // nobody can see (trap 6). Each tab is a settings page: a section's name
  // and what it does on the left, its fields on the right.
  const profile = (
    <form
      className="card settings"
      onSubmit={(event) => {
        event.preventDefault();
        if (badColours.length) return setNotice({ message: `${badColours.map((k) => THEME_LABELS[k]).join(', ')}: a colour is #rgb or #rrggbb.`, kind: 'error' });
        void send('PATCH', `/tenants/${id}`, profileBodyOf(profileFields), 'Saved.');
      }}
    >
      <section className="settings-section" aria-labelledby="sec-identity">
        <div className="settings-about">
          <h2 id="sec-identity">Identity</h2>
          <p>The names on the chat and the staff screens, and the images in the header.</p>
        </div>
        <div className="settings-fields">
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
          {/* The assistant's own picture (D-124): beside every reply, and on the chat's welcome. */}
          <div className="field-row">
            <BrandImageField
              api={api}
              tenantId={id}
              kind="avatar"
              label="Assistant avatar"
              hint={`JPEG, PNG or WebP, shown round beside ${assistantName.trim() || 'the assistant'}'s replies. Empty: the logo, else the first letter of the name.`}
              maxEdge={384}
              value={avatarUrl}
              onChange={setAvatarUrl}
              onUploaded={(saved) => {
                setAvatarUrl(saved.assistantAvatarUrl ?? '');
                onSaved(saved);
              }}
              onMessage={(message, kind) => setNotice({ message, kind })}
              onUnauthorized={onUnauthorized}
            />
          </div>
          {/* Uploaded (D-123), or an address pasted as before. An upload saves at once; Remove waits for Save. */}
          <div className="field-row">
            <BrandImageField
              api={api}
              tenantId={id}
              kind="logo"
              label="Logo"
              hint="JPEG, PNG or WebP. Square works best."
              maxEdge={512}
              value={logoUrl}
              onChange={setLogoUrl}
              onUploaded={(saved) => {
                setLogoUrl(saved.logoUrl ?? '');
                onSaved(saved);
              }}
              onMessage={(message, kind) => setNotice({ message, kind })}
              onUnauthorized={onUnauthorized}
            />
            <BrandImageField
              api={api}
              tenantId={id}
              kind="banner"
              label="Banner"
              hint="JPEG, PNG or WebP. Shown wide behind the booking page's header and on the chat's welcome."
              maxEdge={2000}
              value={bannerUrl}
              onChange={setBannerUrl}
              onUploaded={(saved) => {
                setBannerUrl(saved.bannerUrl ?? '');
                onSaved(saved);
              }}
              onMessage={(message, kind) => setNotice({ message, kind })}
              onUnauthorized={onUnauthorized}
            />
          </div>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="sec-theme">
        <div className="settings-about">
          <h2 id="sec-theme">Theme</h2>
          <p>Five colours, #rgb or #rrggbb. An empty field keeps the default look.</p>
        </div>
        <div className="settings-fields theme-layout">
          <div className="colour-fields">
            {THEME_KEY_LIST.map((key: ThemeKey) => (
              <div className="field" key={key}>
                <label htmlFor={`theme-${key}`}>{THEME_LABELS[key]}</label>
                <div className="colour-input">
                  {/* The picker and the text are one value; the text is the field, so #rgb still works. */}
                  <input
                    type="color"
                    className={hex6(theme[key]) ? 'colour-swatch' : 'colour-swatch unset'}
                    aria-label={`Pick ${THEME_LABELS[key].toLowerCase()}`}
                    value={hex6(theme[key]) ?? '#ffffff'}
                    onChange={(e) => setTheme({ ...theme, [key]: e.target.value })}
                  />
                  <input
                    id={`theme-${key}`}
                    value={theme[key] ?? ''}
                    placeholder="Default"
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => setTheme({ ...theme, [key]: e.target.value })}
                    aria-invalid={badColours.includes(key)}
                  />
                  {/* Its place is kept when there is nothing to reset, so the five rows line up. */}
                  {theme[key] ? (
                    <button type="button" className="icon-button ghost sm colour-reset" aria-label={`Reset ${THEME_LABELS[key].toLowerCase()} to the default`} onClick={() => setTheme({ ...theme, [key]: '' })}>
                      <Icon name="close" size={14} />
                    </button>
                  ) : (
                    <span className="colour-reset" aria-hidden="true" />
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="theme-preview-col">
            <span className="field-label">Preview</span>
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
          </div>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="sec-fallback">
        <div className="settings-about">
          <h2 id="sec-fallback">When the documents cannot answer</h2>
          <p>What the chat says instead, in the reply&apos;s language. Empty uses the built-in words.</p>
        </div>
        <div className="settings-fields">
          {LANGUAGES.map((l) => (
            <div className="field" key={l}>
              <label htmlFor={`fallback-${l}`}>{LANGUAGE_LABELS[l]}</label>
              <textarea id={`fallback-${l}`} rows={3} maxLength={500} value={fallbacks[l]} onChange={(e) => setFallbacks({ ...fallbacks, [l]: e.target.value })} />
            </div>
          ))}
        </div>
      </section>

      <section className="settings-section" aria-labelledby="sec-questions">
        <div className="settings-about">
          <h2 id="sec-questions">Suggested questions</h2>
          <p>
            Buttons on a new chat; a click asks at once. Up to {MAX_SUGGESTED_QUESTIONS}, {MAX_SUGGESTED_QUESTION_LENGTH} characters each,
            in this order.
          </p>
        </div>
        <div className="settings-fields question-grid">
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
        </div>
      </section>

      <SaveBar dirty={profileDirty} busy={busy} onDiscard={discardProfile} label="Save" />
    </form>
  );

  const applications = (
    <form
      className="card settings"
      onSubmit={(event) => {
        event.preventDefault();
        void send('PUT', `/tenants/${id}/applications/bookings`, { config: bookingsConfigOf(bookings) }, bookingsOn ? 'Bookings config saved.' : 'Bookings switched on.');
      }}
    >
      <div className="app-head">
        <span className="app-icon" aria-hidden="true">
          <Icon name="calendar" size={20} />
        </span>
        <div className="app-head-text">
          <h2>
            Bookings <span className={bookingsOn ? 'badge ok' : 'badge'}>{bookingsOn ? 'On' : 'Off'}</span>
          </h2>
          <p className="small muted">
            A bookings screen for staff, the chat&apos;s <code>check_availability</code> tool and, once a unit has a rate, the public
            booking page. Slots, rooms and rates are set on the tenant&apos;s own screens.
          </p>
        </div>
        {bookingsOn && (
          <button
            type="button"
            className="sm"
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
        )}
      </div>

      <section className="settings-section" aria-labelledby="sec-calendar">
        <div className="settings-about">
          <h2 id="sec-calendar">Calendar and money</h2>
          <p>&ldquo;Today&rdquo; is the tenant&apos;s, in this timezone. Per room cannot be switched while bookings are live.</p>
        </div>
        <div className="settings-fields">
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
            <div className="field narrow">
              <label htmlFor="bk-currency">Currency</label>
              <input id="bk-currency" value={bookings.currency} onChange={(e) => setBookings({ ...bookings, currency: e.target.value })} placeholder="PHP" maxLength={3} />
            </div>
          </div>
          <div className="field">
            <span className="field-label" id="bk-weekend-label">
              Weekend days
            </span>
            <div className="day-picks" role="group" aria-labelledby="bk-weekend-label">
              {ISO_DAYS.map(([n, name, full]) => (
                <button
                  key={n}
                  type="button"
                  aria-pressed={weekend.includes(n)}
                  aria-label={full}
                  onClick={() => setBookings({ ...bookings, weekendDays: (weekend.includes(n) ? weekend.filter((d) => d !== n) : [...weekend, n]).sort().join(',') })}
                >
                  {name}
                </button>
              ))}
            </div>
            <p className="hint">The weekend rate applies on these days. None picked = Fri, Sat and Sun, the default.</p>
          </div>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="sec-limits">
        <div className="settings-about">
          <h2 id="sec-limits">Limits</h2>
          <p>The longest stay, and how far ahead a date can be booked. Empty uses the default.</p>
        </div>
        <div className="settings-fields">
          <div className="field-row">
            <div className="field">
              <label htmlFor="bk-nights">Longest stay, nights</label>
              <input id="bk-nights" type="number" min={1} max={60} value={bookings.maxStayNights} onChange={(e) => setBookings({ ...bookings, maxStayNights: e.target.value })} placeholder="14" />
            </div>
            <div className="field">
              <label htmlFor="bk-days">Booking horizon, days</label>
              <input id="bk-days" type="number" min={1} max={730} value={bookings.maxAdvanceDays} onChange={(e) => setBookings({ ...bookings, maxAdvanceDays: e.target.value })} placeholder="365" />
            </div>
          </div>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="sec-page">
        <div className="settings-about">
          <h2 id="sec-page">Booking page</h2>
          <p>Words the customer reads on the tenant&apos;s public booking page.</p>
        </div>
        <div className="settings-fields">
          <div className="field">
            <label htmlFor="bk-instructions">After sending a request</label>
            <textarea id="bk-instructions" rows={5} maxLength={2000} value={bookings.instructions} onChange={(e) => setBookings({ ...bookings, instructions: e.target.value })} />
            <p className="hint">Shown under &ldquo;From {tenant.businessName}&rdquo; on the receipt. Plain text; nothing is filled in.</p>
          </div>
          <div className="field">
            <label htmlFor="bk-hint">Beside the guest count</label>
            <input id="bk-hint" maxLength={200} value={bookings.guestHint} onChange={(e) => setBookings({ ...bookings, guestHint: e.target.value })} placeholder="Do not count children aged 3 and below." />
          </div>
        </div>
      </section>

      <SaveBar dirty={bookingsDirty} busy={busy} onDiscard={bookingsOn ? () => setBookings(savedBookings) : undefined} label={bookingsOn ? 'Save config' : 'Switch on'} />
    </form>
  );

  const archive = (
    <section className={tenant.archivedAt ? 'card settings-archive' : 'card settings-archive danger-zone'}>
      <div className="app-head">
        <span className="app-icon" aria-hidden="true">
          <Icon name={tenant.archivedAt ? 'refresh' : 'alert'} size={20} />
        </span>
        <div className="app-head-text">
          <h2>{tenant.archivedAt ? `Archived since ${new Date(tenant.archivedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : 'Archive this tenant'}</h2>
          <p className="small muted">
            Archived, the tenant answers 404 everywhere: its chat, its admin, its booking page. Nothing is deleted, and it can be
            undone. Deleting for good is a command-line step (<code>tenant:remove</code>), because it takes guest data and
            documents with it.
          </p>
        </div>
        {tenant.archivedAt ? (
          <button type="button" className="primary" disabled={busy} onClick={() => void send('DELETE', `/tenants/${id}/archive`, undefined, 'Unarchived: the tenant resolves again.')}>
            Unarchive
          </button>
        ) : (
          <button
            type="button"
            className="danger"
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

  const since = new Date(tenant.createdAt).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
  return (
    <>
      {dialog}
      <div className="tenant-edit-head">
        {onBack && (
          <button type="button" className="link back-link" onClick={onBack}>
            <Icon name="chevron-left" size={16} /> Tenants
          </button>
        )}
        <div className="tenant-edit-title">
          <TenantMark businessName={tenant.businessName} logoUrl={tenant.logoUrl} size="lg" />
          <div className="tenant-edit-name">
            <h1 className="page-title">
              {tenant.businessName}{' '}
              <span className={tenant.archivedAt ? 'badge' : 'badge ok'}>{tenant.archivedAt ? 'Archived' : 'Live'}</span>
            </h1>
            <p className="tenant-meta">
              /t/{tenant.slug} · {tenant.assistantName} · {tenant.members} member{tenant.members === 1 ? '' : 's'} · since {since}
            </p>
          </div>
          {!tenant.archivedAt && (
            <a className="button" href={`/t/${tenant.slug}`} target="_blank" rel="noreferrer">
              <Icon name="chat" size={16} /> Open chat
            </a>
          )}
        </div>
      </div>
      <Tabs
        label={`${tenant.businessName} settings`}
        tabs={[
          { id: 'profile', label: 'Profile', panel: profile },
          { id: 'applications', label: 'Applications', panel: applications },
          {
            id: 'features',
            label: 'Features',
            panel: (
              <FeaturesPanel
                switches={tenant.features}
                bookingsOn={bookingsOn}
                busy={busy}
                onSwitch={(key, enabled) => void send('PUT', `/tenants/${id}/features/${key}`, { enabled }, `${enabled ? 'Switched on' : 'Switched off'}.`)}
              />
            ),
          },
          { id: 'members', label: 'Members', panel: <MembersPanel api={`${api}/tenants/${id}/members`} selfUserId={selfUserId} onUnauthorized={onUnauthorized} /> },
          { id: 'archive', label: tenant.archivedAt ? 'Archived' : 'Archive', panel: archive },
        ]}
      />
    </>
  );
}

/**
 * The bottom of a settings form, kept in view while it scrolls: whether
 * anything is unsaved, Discard, and the ONE submit. Save stays enabled when
 * nothing changed (a re-save is harmless), but says so.
 */
function SaveBar({ dirty, busy, onDiscard, label }: { dirty: boolean; busy: boolean; onDiscard?: () => void; label: string }) {
  return (
    <div className={dirty ? 'save-bar dirty' : 'save-bar'}>
      <span className="save-bar-state" role="status">
        {dirty ? (
          <>
            <span className="save-dot" aria-hidden="true" /> Unsaved changes
          </>
        ) : (
          <>
            <Icon name="check" size={14} /> Everything is saved
          </>
        )}
      </span>
      {dirty && onDiscard && (
        <button type="button" disabled={busy} onClick={onDiscard}>
          Discard
        </button>
      )}
      <button type="submit" className="primary" disabled={busy}>
        {busy ? 'Saving…' : label}
      </button>
    </div>
  );
}
