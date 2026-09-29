// alteza-load.mjs — ingest sample-documents/alteza/01–11 into tenant alteza.
//
// Idempotent by TITLE (the file's first heading): a document already there
// with the same content is skipped; one whose content differs is replaced
// (updateDocument: new id, D-044); one missing is ingested. README.md is
// never loaded: it indexes the corpus and would answer nothing.
//
// Runs as alteza's OPERATOR member on a staff token, through the same
// pipeline functions the admin route calls (plan/auth-rls.md § 2.7), never
// as service_role. One embedding call per document, a fraction of a cent.
//
//   cd packages/rag && node --conditions=react-server --env-file=../../.env ../../plan/alteza-load.mjs

import { readdirSync, readFileSync } from 'node:fs';
import { asOperator } from '../packages/db/dist/service.js';
import { getDocument, ingestDocument, listDocuments, loadTenant, updateDocument } from '../packages/rag/dist/index.js';

const dir = new URL('../sample-documents/alteza/', import.meta.url);
const files = readdirSync(dir)
  .filter((f) => /^\d\d-.*\.md$/.test(f))
  .sort();

const chat = await loadTenant('alteza');
if (!chat) throw new Error('No tenant "alteza": run tenant:add first');
const alteza = await asOperator(chat);

const existing = await listDocuments(alteza);
for (const file of files) {
  const content = readFileSync(new URL(file, dir), 'utf8');
  const title = content.match(/^# (.+)$/m)?.[1]?.trim();
  if (!title) throw new Error(`${file}: no "# " heading`);
  const source = `sample-documents/alteza/${file}`;
  const matches = existing.filter((d) => d.title === title);
  if (matches.length > 1) throw new Error(`alteza: ${matches.length} documents titled "${title}"`);
  const match = matches[0];
  if (match) {
    const stored = await getDocument(alteza, match.id);
    if (stored?.content === content) {
      console.log(`unchanged  #${match.id}  ${title}`);
      continue;
    }
    const result = await updateDocument({ tenant: alteza, id: match.id, title, source, content });
    console.log(`replaced   #${match.id} → #${result?.id}  ${title}  (${result?.chunkCount} chunks)`);
  } else {
    const result = await ingestDocument({ tenant: alteza, title, source, content });
    console.log(`ingested   #${result.id}  ${title}  (${result.chunkCount} chunks)`);
  }
}

const after = await listDocuments(alteza);
console.log(`alteza: ${after.length} documents, ${after.reduce((n, d) => n + (d.chunkCount ?? 0), 0)} chunks`);
