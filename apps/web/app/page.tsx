// Placeholder. The chat screen (S-1) and the admin screen (S-2) are Phase 6 —
// this phase is the API only, and building the UI early is how a migration
// stops being reviewable one step at a time.
//
// Until then the POC's own pages still work, unchanged, from apps/legacy-poc.
export default function Page() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '3rem', lineHeight: 1.6 }}>
      <h1>RAG Chatbot — API only</h1>
      <p>
        The six routes are live under <code>/api</code>. The two screens arrive in Phase 6; see{' '}
        <code>plan/steps.md</code>.
      </p>
    </main>
  );
}
