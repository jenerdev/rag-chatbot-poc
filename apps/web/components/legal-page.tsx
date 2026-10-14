import { LEGAL_DRAFT_NOTICE, type LegalDocument } from '@/lib/legal';

/**
 * A privacy policy or terms page's body (D-129): the title, the draft notice
 * (every text in lib/legal.ts is a placeholder until a lawyer replaces it),
 * then each section. Every string is a React child, never HTML.
 */
export function LegalBody({ doc }: { doc: LegalDocument }) {
  return (
    <article className="legal-doc" aria-labelledby="legal-title">
      <h1 className="page-title" id="legal-title">
        {doc.title}
      </h1>
      <p className="small muted legal-version">Version {doc.version}</p>
      <p className="notice warn legal-draft" role="note">
        {LEGAL_DRAFT_NOTICE}
      </p>
      {doc.sections.map((s) => (
        <section key={s.heading}>
          <h2>{s.heading}</h2>
          {s.paragraphs.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </section>
      ))}
    </article>
  );
}
