import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'RAG Chatbot POC',
  description: 'Answers questions from documents you paste in.',
};

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
