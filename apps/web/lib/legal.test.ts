import { describe, expect, it } from 'vitest';
import { daysInWords, platformPrivacy, tenantPrivacy, tenantTerms, type TenantLegalFacts } from './legal';

const VILLA: TenantLegalFacts = {
  businessName: 'Villa Amihan',
  assistantName: 'Lia',
  contactName: 'Ana Cruz',
  contactEmail: 'privacy@villa.example',
  policyVersion: '2',
  chatRetentionDays: 365,
  guestRetentionDays: 1095,
  proofRetentionDays: 180,
  bookings: true,
};
const text = (d: { sections: { heading: string; paragraphs: string[] }[] }) => d.sections.flatMap((s) => [s.heading, ...s.paragraphs]).join('\n');

describe('legal texts (D-129)', () => {
  it('reads a period in days and roughly', () => {
    expect(daysInWords(365)).toBe('365 days (about 1 year)');
    expect(daysInWords(1095)).toBe('1095 days (about 3 years)');
    expect(daysInWords(90)).toBe('90 days (about 3 months)');
  });

  it("states the tenant's own facts: the controller, its contact, OpenAI, the periods, the version", () => {
    const t = text(tenantPrivacy(VILLA));
    for (const fact of ['Villa Amihan is the personal information controller', 'Ana Cruz, at privacy@villa.example', 'OpenAI', '365 days', '1095 days', '180 days after your stay', 'version 2']) expect(t).toContain(fact);
  });

  it('says nothing about bookings, receipts or guest details for a tenant without bookings', () => {
    const t = text(tenantPrivacy({ ...VILLA, bookings: false }));
    expect(t).not.toMatch(/receipt|booking request/i);
    expect(text(tenantTerms({ ...VILLA, bookings: false }))).not.toMatch(/Booking requests/);
  });

  it('with no contact set, points to the resort itself', () => {
    expect(text(tenantPrivacy({ ...VILLA, contactName: null, contactEmail: null }))).toContain('Villa Amihan, through the contact details');
  });

  it("the platform's policy says the landing page sets no cookie", () => {
    expect(text(platformPrivacy())).toContain('sets no cookie');
  });
});
