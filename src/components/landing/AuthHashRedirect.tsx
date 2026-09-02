"use client";

import { useEffect } from "react";

// Supabase returnerer recovery-links med tokenet i URL'ens hash-fragment
// (#access_token=...&type=recovery). Fragmenter sendes aldrig med i HTTP-
// forespørgslen, så hverken middleware eller /auth/callback kan se dem - det
// skal fanges her i browseren.
//
// Lander man på "/" med et fragment, bevarer browseren det gennem gatens
// redirect til /coming-soon. Derfor sidder denne komponent netop her.
export default function AuthHashRedirect() {
  useEffect(() => {
    // Kører både ved mount (det normale: brugeren lander her fra mailen) og
    // ved hashchange - en ren hash-ændring genmonterer ikke komponenten.
    function tjekHash() {
      const hash = window.location.hash;
      if (hash.length < 2) return;

      const params = new URLSearchParams(hash.slice(1));

      // Udløbet eller ugyldigt link: Supabase lægger fejlen i fragmentet.
      const fejl = params.get("error_description") ?? params.get("error");
      if (fejl) {
        window.location.replace(`/login?fejl=${encodeURIComponent(fejl)}`);
        return;
      }

      // Nulstilling af adgangskode. Fragmentet føres med videre, så Supabase-
      // klienten på målsiden kan oprette recovery-sessionen ud fra det.
      // replace() frem for push(), så coming-soon ikke ligger i historikken og
      // sender brugeren tilbage hertil ved tryk på "tilbage".
      if (params.get("type") === "recovery" && params.get("access_token")) {
        window.location.replace(`/reset-password${hash}`);
      }
    }

    tjekHash();
    window.addEventListener("hashchange", tjekHash);
    return () => window.removeEventListener("hashchange", tjekHash);
  }, []);

  return null;
}
