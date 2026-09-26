// isolation.mjs — tenant isolation, checked through the pipeline itself.
//
// Tenancy Phase 3. verify.mjs proves isolation in SQL; this proves it one
// layer up, through the functions the routes call. Each check asks one tenant
// for something that belongs to the other, and passes only when the answer is
// "nothing". Needs both tenants loaded (northwind and villa) and an OpenAI key.
//
// It writes, and cleans up after itself: two conversations, and one probe
// document ingested into villa, edited, and then deleted.
//
// TWO WALLS (plan/auth-rls.md Rule 1). By default every context is what the
// app gets from loadTenant(): a CHAT token, so both the code filters and RLS
// stand between the tenants. With --filters-only, every context's db is the
// service client instead. RLS is bypassed, and only the `.eq('tenant_id', …)`
// filters are left. The suite must pass BOTH ways. Passing only the first
// would mean nobody knows whether the filters still hold.
//
// Admin writes (the probe ingest and its delete) run as villa's OPERATOR
// member, on a staff token, as the admin routes' do (auth-rls § 2.7). With
// --filters-only they run on the service client like everything else.
// Needs: pnpm --filter @rag/db member:operator -- villa
//
// Run:  pnpm --filter @rag/pipeline isolation [-- --filters-only]
import { asOperator, supabase as service } from '@rag/db/service';
import { loadTenant, listDocuments, getChunks, deleteDocument, answerQuestion, getMessages, ingestDocument, listUnanswered, resolveUnanswered, reopenUnanswered, getDocument, updateDocument, NO_ANSWER } from '../dist/index.js';
let fail = 0;
const check = (ok, label, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  — ${detail}`); if (!ok) fail++; };
const filtersOnly = process.argv.includes('--filters-only');
const as = (t) => (t && filtersOnly ? { ...t, db: service } : t);
console.log(filtersOnly ? 'WALL: code filters alone (service client, RLS bypassed)' : 'WALL: filters + RLS (chat tokens, as the app)');
const nw = as(await loadTenant('northwind')), villa = as(await loadTenant('villa'));
const villaAdmin = filtersOnly ? villa : await asOperator(villa);
check(nw && villa && (await loadTenant('nope')) === null, 'loadTenant', `northwind ${nw?.id}, villa ${villa?.id}, nope null`);
check(!('adminKeyHash' in nw) && !('admin_key_hash' in nw), 'no admin hash in TenantContext', Object.keys(nw).join(','));
const dn = await listDocuments(nw), dv = await listDocuments(villa);
check(dn.length === 1 && dv.length === 8, 'listDocuments per tenant', `northwind ${dn.length} [${dn.map(d=>d.chunkCount)}], villa ${dv.length} [${dv.map(d=>d.chunkCount)}]`);
const vdoc = dv.at(-1).id;
check((await getChunks(nw, vdoc)).length === 0 && (await getChunks(villa, vdoc)).length > 0, 'getChunks cross-tenant is empty', `doc ${vdoc}`);
const gX = await getDocument(nw, vdoc), gV = await getDocument(villa, vdoc);
check(gX === null && gV?.id === vdoc && gV.content.length > 0, 'getDocument cross-tenant is null', `northwind ${gX}, villa ${gV?.content.length} chars`);
check((await deleteDocument(nw, vdoc)) === false && (await listDocuments(villa)).length === 8, 'deleteDocument cross-tenant refused', `doc ${vdoc} survives`);
const q = 'How many parking spaces does the building have?';
const aN = await answerQuestion({ tenant: nw, conversationId: null, message: q });
check(aN.refused, 'northwind refuses the villa fact', aN.reply);
const aV = await answerQuestion({ tenant: villa, conversationId: null, message: 'How many cars can park at the resort?' });
check(!aV.refused && aV.sources.every(s => dv.some(d => d.id === s.documentId)), 'villa answers from villa sources only', `${aV.reply.slice(0,90)} | ${[...new Set(aV.sources.map(s=>s.documentTitle))].join('; ')}`);
const hijack = await answerQuestion({ tenant: nw, conversationId: aV.conversationId, message: 'hi' });
check(hijack.conversationId !== aV.conversationId, 'a villa conversation id is not reused by northwind', `${aV.conversationId.slice(0,8)} -> ${hijack.conversationId.slice(0,8)}`);
const mX = await getMessages(nw, aV.conversationId), mV = await getMessages(villa, aV.conversationId);
check(mX === null && mV?.length === 2, 'getMessages cross-tenant is null', `northwind ${mX}, villa ${mV?.length} messages`);
// Northwind's refusal above is on its unanswered list (the positive twin, so
// this cannot pass on zero rows) and nowhere on villa's.
const uN = await listUnanswered(nw), uV = await listUnanswered(villa);
check(uN.some(u => u.question === q) && !uV.some(u => u.question === q) && !uV.some(v => uN.some(n => n.id === v.id)), 'listUnanswered per tenant', `northwind ${uN.length}, villa ${uV.length}, the refusal only in northwind's`);
// Resolutions are staff data, so these run on villa's operator (staff) token.
// Villa cannot resolve northwind's refusal; villa's own round trip moves a
// question from open to resolved and back, leaving the data as it found it.
const nRefusal = uN.find(u => u.question === q), vOpen = await listUnanswered(villaAdmin);
check(nRefusal && (await resolveUnanswered(villaAdmin, nRefusal.id)) === false && (await reopenUnanswered(villaAdmin, nRefusal.id)) === false
  && !(await listUnanswered(nw, { resolved: true })).some(u => u.id === nRefusal.id), 'resolve cross-tenant refused', `northwind refusal ${nRefusal?.id}`);
const target = vOpen[0];
const resolvedOk = target && await resolveUnanswered(villaAdmin, target.id);
const movedOut = !(await listUnanswered(villaAdmin)).some(u => u.id === target?.id);
const movedIn = (await listUnanswered(villaAdmin, { resolved: true })).some(u => u.id === target?.id && u.resolvedAt);
const reopened = target && await reopenUnanswered(villaAdmin, target.id);
const back = (await listUnanswered(villaAdmin)).some(u => u.id === target?.id);
check(resolvedOk && movedOut && movedIn && reopened && back, 'resolve and reopen in its own tenant', `villa question ${target?.id}: resolved ${resolvedOk}, left open ${movedOut}, in resolved ${movedIn}, reopened ${reopened}, open again ${back}`);
const r = await ingestDocument({ tenant: villaAdmin, title: 'isolation probe', content: 'The probe word is zanzibarquartz.' });
const inV = (await listDocuments(villa)).some(d => d.id === r.id && d.chunkCount === 1), inN = (await listDocuments(nw)).some(d => d.id === r.id);
check(inV && !inN, 'ingest lands in the right tenant, chunks and all', `doc ${r.id}, ${r.chunkCount} chunk`);
// An edit from the wrong tenant is refused before anything is written, and
// the right tenant's edit replaces the document: new id, old one gone.
const eX = await updateDocument({ tenant: nw, id: r.id, title: 'hijack', content: 'The probe word is hijacked.' });
const r2 = await updateDocument({ tenant: villaAdmin, id: r.id, title: 'isolation probe', content: 'The probe word is zanzibaropal.' });
const after = await listDocuments(villa), afterN = await listDocuments(nw);
check(eX === null && r2 && r2.id !== r.id && !after.some(d => d.id === r.id) && after.some(d => d.id === r2.id && d.chunkCount === 1)
  && !afterN.some(d => d.id === r2.id || d.title === 'hijack') && (await getDocument(villa, r2.id))?.content.includes('zanzibaropal'),
  'updateDocument replaces in its own tenant only', `northwind ${eX}, doc ${r.id} -> ${r2?.id}`);
check(await deleteDocument(villaAdmin, r2.id), 'probe document removed', `doc ${r2.id}`);
console.log(fail ? `\n${fail} FAILED` : '\nALL ISOLATION CHECKS PASS');
