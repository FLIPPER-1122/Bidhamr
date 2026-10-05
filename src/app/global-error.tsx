"use client"; // Fejlgrænser skal være klientkomponenter

import { useRapporterFejl } from "@/components/drift/useRapporterFejl";

// Sidste udvej: vises kun, hvis selve rodlayoutet fejler, eller en fejl ikke
// fanges af en nærmere error.tsx. Erstatter rodlayoutet og får hverken
// globals.css eller skrifttyper med - derfor simple inline-styles.
// Fejlen logges til /admin/drift (kun sti, besked og digest).
export default function GlobalFejl({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useRapporterFejl(error);

  return (
    <html lang="da">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          background: "#ffffff",
          color: "#1a1a1a",
          padding: "1rem",
        }}
      >
        <title>Noget gik galt · BidHamr</title>
        <div style={{ maxWidth: 420, textAlign: "center" }}>
          <h1 style={{ fontSize: "1.5rem", margin: 0, fontFamily: "Georgia, serif", fontWeight: 600 }}>Noget gik galt</h1>
          <p style={{ marginTop: "0.5rem", fontSize: "0.875rem", color: "#737373" }}>
            Siden kunne ikke vises. Prøv igen om lidt.
            {error.digest && (
              <span style={{ display: "block", marginTop: "0.25rem", fontSize: "0.75rem", color: "#a3a3a3" }}>
                Fejlkode: {error.digest}
              </span>
            )}
          </p>
          <div style={{ marginTop: "1.5rem", display: "flex", gap: "1rem", justifyContent: "center", alignItems: "center" }}>
            <button
              type="button"
              onClick={() => retry()}
              style={{
                border: "1px solid #1e5e4a",
                color: "#1e5e4a",
                background: "#fff",
                borderRadius: 8,
                padding: "0.625rem 1.25rem",
                fontSize: "0.875rem",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Prøv igen
            </button>
            {/* Almindeligt link: rodlayoutet er nede, så klient-navigation kan ikke bruges. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" style={{ fontSize: "0.875rem", fontWeight: 500, color: "#1e5e4a" }}>
              Til forsiden
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
