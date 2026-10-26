import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'RAG Chatbot POC',
  description: 'Answers questions from documents you paste in.',
};

// D-150: where the server code runs. Every page and route is a chain of
// round trips to the database, and the database (Supabase) is in Singapore;
// Vercel's default is US East, which put the Pacific in each hop. ONE
// export, here at the root, and every segment under it inherits it
// (Next's route segment config). Vercel's own ID for Singapore is `sin1`;
// the dashboard's Functions → Region setting is the same knob by hand, and
// must agree. Another platform ignores this line, which is harmless.
export const preferredRegion = 'sin1';

// Both pages render their own <header>, exactly as the two HTML files did —
// the chat page's carries a "New chat" button that the admin page has no use
// for, and hoisting it here would mean a shared header that immediately needs
// to know which page it is on.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
