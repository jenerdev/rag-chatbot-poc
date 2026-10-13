import Link from 'next/link';

/**
 * The foot of the booking page and Manage booking (plan/public-brand.md):
 * the business's name, and the links a guest rarely needs but must be able
 * to find (Book a stay, from Manage booking, since the header has no Book
 * button). "Staff login" lived in the header beside the guest's own
 * links; it is staff's, so it moved down here. The chat has no footer: it
 * is a full-height conversation.
 */
export function PublicFooter({ slug, businessName, manage, book = false }: { slug: string; businessName: string; manage: boolean; book?: boolean }) {
  return (
    <footer className="public-footer">
      <span>
        © {new Date().getFullYear()} {businessName}
      </span>
      <nav aria-label="More">
        {book && <Link href={`/t/${slug}/book`}>Book a stay</Link>}
        {manage && <Link href={`/t/${slug}/manage`}>Manage booking</Link>}
        <Link href={`/t/${slug}/admin`}>Staff login</Link>
      </nav>
    </footer>
  );
}
