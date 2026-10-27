"use client";

import { useEffect, useRef } from "react";
import { TURNSTILE_SITE_KEY, turnstileAktiv } from "@/lib/turnstile";

// Cloudflare Turnstile-feltet ("Bekræft, at du er et menneske"). Viser intet,
// når NEXT_PUBLIC_TURNSTILE_SITE_KEY ikke er sat. Se src/lib/turnstile.ts.
//
// onToken får tokenet (eller null, når det udløber eller fejler). Et token
// kan kun bruges én gang: tæl nulstil op efter hvert forsøg, så laves et nyt.
// Scriptet hentes først, når feltet vises (ingen Cloudflare-kald ellers).

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  remove: (id: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let indlaesning: Promise<TurnstileApi> | null = null;

function hentTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  indlaesning ??= new Promise<TurnstileApi>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile mangler")));
    s.onerror = () => {
      indlaesning = null;
      reject(new Error("Turnstile kunne ikke hentes"));
    };
    document.head.appendChild(s);
  });
  return indlaesning;
}

export default function Turnstile({
  onToken,
  handling,
  nulstil = 0,
}: {
  onToken: (token: string | null) => void;
  // Cloudflare "action" (vises i Cloudflares statistik): login, glemt, opret.
  handling: string;
  nulstil?: number;
}) {
  const boks = useRef<HTMLDivElement>(null);
  // Seneste onToken uden at tegne feltet igen, hver gang forælderen renderer.
  const tilbage = useRef(onToken);
  useEffect(() => {
    tilbage.current = onToken;
  }, [onToken]);

  useEffect(() => {
    if (!turnstileAktiv() || !boks.current) return;
    let id: string | null = null;
    let aktiv = true;
    tilbage.current(null);
    hentTurnstile()
      .then((ts) => {
        if (!aktiv || !boks.current) return;
        id = ts.render(boks.current, {
          sitekey: TURNSTILE_SITE_KEY,
          action: handling,
          language: "da",
          size: "flexible",
          callback: (t: string) => tilbage.current(t),
          "expired-callback": () => tilbage.current(null),
          "error-callback": () => tilbage.current(null),
        });
      })
      .catch((err) => console.error("Turnstile:", err));
    return () => {
      aktiv = false;
      if (id && window.turnstile) window.turnstile.remove(id);
    };
  }, [handling, nulstil]);

  if (!turnstileAktiv()) return null;
  return <div ref={boks} className="min-h-[65px]" />;
}
