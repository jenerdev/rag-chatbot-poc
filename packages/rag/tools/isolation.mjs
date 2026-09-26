// isolation.mjs — tenant isolation, checked through the pipeline itself.
//
// Tenancy Phase 3. verify.mjs proves isolation in SQL; this proves it one
// layer up, through the functions the routes call. Each check asks one tenant
// for something that belongs to the other, and passes only when the answer is
// "nothing". Needs both tenants loaded (northwind and villa) and an OpenAI key.
//
// It writes, and cleans up after itself: two conversations, and one probe
// document ingested into villa and then deleted.
//
// TWO WALLS (plan/auth-rls.md Rule 1). By default every context is what the
// app gets from loadTenant(): a CHAT token, so both the code filters and RLS
// stand between the tenants. With --filters-only, every context's db is the
// service client instead. RLS is bypassed, and only the `.eq('tenant_id', …)`
// filters are left. The suite must pass BOTH ways. Passing only the first
// would mean nobody knows whether the filters still hold.
//
// Admin writes (the probe ingest and its delete) run on the service client in
// both modes, until auth-rls Phase 5 gives the tools an operator member to
// mint a staff token for. That is setup, not the thing under test.
//
// Run:  pnpm --filter @rag/pipeline isolation [-- --filters-only]
import { supabase as service } from '@rag/db/service';
import { loadTenant, listDocuments, getChunks, deleteDocument, answerQuestion, getMessages, ingestDocument, NO_ANSWER } from '../dist/index.js';
let fail = 0;
const check = (ok, label, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  — ${detail}`); if (!ok) fail++; };
const filtersOnly = process.argv.includes('--filters-only');
const as = (t) => (t && filtersOnly ? { ...t, db: service } : t);
console.log(filtersOnly ? 'WALL: code filters alone (service client, RLS bypassed)' : 'WALL: filters + RLS (chat tokens, as the app)');
const nw = as(await loadTenant('northwind')), villa = as(await loadTenant('villa'));
const villaAdmin = { ...villa, db: service }; // until Phase 5's operator member
check(nw && villa && (await loadTenant('nope')) === null, 'loadTenant', `northwind ${nw?.id}, villa ${villa?.id}, nope null`);
check(!('adminKeyHash' in nw) && !('admin_key_hash' in nw), 'no admin hash in TenantContext', Object.keys(nw).join(','));
const dn = await listDocuments(nw), dv = await listDocuments(villa);
check(dn.length === 1 && dv.length === 8, 'listDocuments per tenant', `northwind ${dn.length} [${dn.map(d=>d.chunkCount)}], villa ${dv.length} [${dv.map(d=>d.chunkCount)}]`);
const vdoc = dv.at(-1).id;
check((await getChunks(nw, vdoc)).length === 0 && (await getChunks(villa, vdoc)).length > 0, 'getChunks cross-tenant is empty', `doc ${vdoc}`);
check((await deleteDocument(nw, vdoc)) === false && (await listDocuments(villa)).length === 8, 'deleteDocument cross-tenant refused', `doc ${vdoc} survives`);
const q = 'How many parking spaces does the building have?';
const aN = await answerQuestion({ tenant: nw, conversationId: null, message: q });
check(aN.reply.trim() === NO_ANSWER, 'northwind refuses the villa fact', aN.reply);
const aV = await answerQuestion({ tenant: villa, conversationId: null, message: 'How many cars can park at the resort?' });
check(aV.reply.trim() !== NO_ANSWER && aV.sources.every(s => dv.some(d => d.id === s.documentId)), 'villa answers from villa sources only', `${aV.reply.slice(0,90)} | ${[...new Set(aV.sources.map(s=>s.documentTitle))].join('; ')}`);
const hijack = await answerQuestion({ tenant: nw, conversationId: aV.conversationId, message: 'hi' });
check(hijack.conversationId !== aV.conversationId, 'a villa conversation id is not reused by northwind', `${aV.conversationId.slice(0,8)} -> ${hijack.conversationId.slice(0,8)}`);
const mX = await getMessages(nw, aV.conversationId), mV = await getMessages(villa, aV.conversationId);
check(mX === null && mV?.length === 2, 'getMessages cross-tenant is null', `northwind ${mX}, villa ${mV?.length} messages`);
const r = await ingestDocument({ tenant: villaAdmin, title: 'isolation probe', content: 'The probe word is zanzibarquartz.' });
const inV = (await listDocuments(villa)).some(d => d.id === r.id && d.chunkCount === 1), inN = (await listDocuments(nw)).some(d => d.id === r.id);
check(inV && !inN, 'ingest lands in the right tenant, chunks and all', `doc ${r.id}, ${r.chunkCount} chunk`);
check(await deleteDocument(villaAdmin, r.id), 'probe document removed', `doc ${r.id}`);
console.log(fail ? `\n${fail} FAILED` : '\nALL ISOLATION CHECKS PASS');
