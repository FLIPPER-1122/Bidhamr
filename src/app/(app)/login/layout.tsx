import type { Metadata } from "next";

// Siden er en klientkomponent og kan ikke selv eksportere metadata.
export const metadata: Metadata = {
  title: "Log ind",
  description: "Log ind på BidHamr for at byde, sælge og følge dine handler.",
  alternates: { canonical: "/login" },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
