import type { Metadata } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { fontClassNames } from './fonts';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Medusa — Admin',
  description: 'HQ and store administration.',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Every page renders per request: the CSP's script nonce is new on each response, and Next can
  // only stamp it on its inline scripts at render time — a prerendered page would carry none and be
  // blocked (src/lib/security/csp.ts).
  await connection();
  return (
    <html lang="en" className={fontClassNames}>
      <body className="min-h-screen font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
