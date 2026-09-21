import type { ReactNode } from 'react';

export const metadata = {
  title: 'RAG Chatbot',
  description: 'Answers questions from documents you paste in.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
