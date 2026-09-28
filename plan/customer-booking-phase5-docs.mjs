// customer-booking-phase5-docs.mjs — re-ingest the "how to book" documents
// after their edit (plan/customer-booking.md Phase 5, § 8 q5).
//
//   villa   sample-documents/02-rates-and-schedules.md   (+ one line: the page shows the exact price)
//           sample-documents/04-booking-and-payment.md   ("How to book": the Book button and the page)
//   harbor  fixtures/harbor.json                          (+ a BOOKING section)
//
// A document is found by its title, and replaced only if its stored content
// differs from the file, so a second run changes nothing. Replacing is
// updateDocument(): ingest the new version, then delete the old one, so the
// document gets a NEW id (D-044), and chunking changes are picked up (trap 7).
//
// Runs as each tenant's OPERATOR member on a staff token (plan/auth-rls.md
// § 2.7), through the same pipeline functions the admin routes call. The
// embedding calls cost a fraction of a cent.
//
//   cd packages/rag && node --conditions=react-server --env-file=../../.env ../../plan/customer-booking-phase5-docs.mjs

import { readFileSync } from 'node:fs';
import { asOperator } from '../packages/db/dist/service.js';
import { getDocument, listDocuments, loadTenant, updateDocument } from '../packages/rag/dist/index.js';

const file = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const harbor = JSON.parse(file('fixtures/harbor.json'));

const WANT = {
  villa: [
    { title: 'Villa Amihan — Rates and Booking Schedules', source: 'sample-documents/02-rates-and-schedules.md', content: file('sample-documents/02-rates-and-schedules.md') },
    { title: 'Villa Amihan — Booking, Payment and Cancellation', source: 'sample-documents/04-booking-and-payment.md', content: file('sample-documents/04-booking-and-payment.md') },
  ],
  harbor: [{ title: harbor.title, source: harbor.source, content: harbor.content }],
};

for (const [slug, docs] of Object.entries(WANT)) {
  const chat = await loadTenant(slug);
  if (!chat) throw new Error(`No tenant "${slug}"`);
  const tenant = await asOperator(chat);
  const existing = await listDocuments(tenant);
  for (const want of docs) {
    const matches = existing.filter((d) => d.title === want.title);
    if (matches.length !== 1) throw new Error(`${slug}: ${matches.length} documents titled "${want.title}", expected 1`);
    const stored = await getDocument(tenant, matches[0].id);
    if (stored?.content === want.content) {
      console.log(`${slug}: "${want.title}" (#${matches[0].id}) unchanged, skipped`);
      continue;
    }
    const result = await updateDocument({ tenant, id: matches[0].id, title: want.title, source: want.source, content: want.content });
    console.log(`${slug}: "${want.title}" #${matches[0].id} → #${result?.id}, ${result?.chunkCount ?? '?'} chunks`);
  }
  const after = await listDocuments(tenant);
  console.log(`${slug}: ${after.length} documents now`);
}
