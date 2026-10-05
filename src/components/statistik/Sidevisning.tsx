"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

// Cookiefri besøgsstatistik: sender stien (uden query-streng) til
// /api/statistik, hver gang man skifter side. Ingen cookies sættes, intet id,
// intet gemt i browseren. Har brugeren slået "Do Not Track" eller Global
// Privacy Control til, sendes intet. Serveren normaliserer stien (id'er
// fjernes) og gemmer kun et antal pr. dag og side.
export default function Sidevisning() {
  const sti = usePathname();

  useEffect(() => {
    // Admin og dev tælles ikke (serveren dropper dem også).
    if (!sti || sti.startsWith("/admin") || sti.startsWith("/dev")) return;
    const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
    if (nav.doNotTrack === "1" || nav.globalPrivacyControl === true) return;
    const data = JSON.stringify({ sti });
    try {
      // text/plain giver ingen CORS-preflight.
      const sendt =
        typeof nav.sendBeacon === "function" &&
        nav.sendBeacon("/api/statistik", new Blob([data], { type: "text/plain" }));
      if (!sendt) {
        fetch("/api/statistik", {
          method: "POST",
          body: data,
          headers: { "Content-Type": "text/plain" },
          keepalive: true,
          credentials: "omit",
        }).catch(() => {});
      }
    } catch {
      // Statistik må aldrig give fejl på siden.
    }
  }, [sti]);

  return null;
}
