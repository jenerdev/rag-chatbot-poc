// The root. A plain static page that says what this is.
//
// It does NOT redirect to a tenant, and it does NOT list them (plan.md
// Phase 7). A redirect is a default tenant by another name, and a list of
// tenants is a customer list. Each tenant has its own address, /t/<slug>, and
// is reached by being given it.

export default function Home() {
  return (
    <main>
      <section className="card">
        <h2>Document assistant</h2>
        <p className="small muted">
          Each workspace answers questions from its own documents, and shows the exact passages
          every answer was built from. Open the address for your workspace to begin.
        </p>
      </section>
    </main>
  );
}
