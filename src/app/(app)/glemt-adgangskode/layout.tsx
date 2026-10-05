import type { Metadata } from "next";

// Siden er en klientkomponent og kan ikke selv eksportere metadata.
export const metadata: Metadata = {
  title: "Glemt adgangskode",
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
