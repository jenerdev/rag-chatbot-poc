// An unknown tenant slug.
//
// Says what happened and nothing more. It gives no hint about which slugs DO
// exist, and has no link to a tenant list: a tenant directory is a customer
// list (plan.md Phase 7).

export default function TenantNotFound() {
  return (
    <main>
      <section className="card">
        <h2>No such workspace</h2>
        <p className="small muted">Check the address you were given.</p>
      </section>
    </main>
  );
}
