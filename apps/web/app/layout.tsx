import "./globals.css";
import type { Metadata } from "next";
import Link from "next/link";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "cozy-bet",
  description: "Say bet. Settle on-chain.",
};

function Nav() {
  // Tiny site nav. /admin/arbiter-cases is gated server-side so it's safe
  // to advertise — non-admins see "Log in" / "not authorized" there.
  return (
    <nav
      style={{
        padding: "12px 24px",
        borderBottom: "1px solid #2a2a35",
        display: "flex",
        gap: 16,
        alignItems: "center",
        fontSize: 14,
      }}
    >
      <Link
        href="/"
        style={{ fontWeight: 700, textDecoration: "none" }}
      >
        cozy-bet
      </Link>
      <Link href="/explorer">explorer</Link>
      <Link href="/me">me</Link>
      <Link
        href="/admin/arbiter-cases"
        className="muted"
        style={{ marginLeft: "auto", fontSize: 13 }}
      >
        admin
      </Link>
    </nav>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <Nav />
          {children}
        </Providers>
      </body>
    </html>
  );
}
