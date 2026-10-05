"use client";

import { useEffect, useState } from "react";
import { gensendBekraeftelse } from "@/app/actions/auth";

// "Send mailen igen" med ventetid. Uden email bruger serveren adressen fra
// signup-cookien. Serveren og Supabase har desuden egne grænser.
const VENTETID_SEK = 60;

export default function GensendBekraeftelse({
  email,
  variant = "sekundaer",
  startVentetid = false,
}: {
  email?: string;
  variant?: "sekundaer" | "tekst";
  // Vent også før første klik (mailen er lige sendt).
  startVentetid?: boolean;
}) {
  const [sekunder, setSekunder] = useState(startVentetid ? VENTETID_SEK : 0);
  const [sender, setSender] = useState(false);
  const [besked, setBesked] = useState<{ ok: boolean; tekst: string } | null>(null);

  useEffect(() => {
    if (sekunder <= 0) return;
    const t = setTimeout(() => setSekunder((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [sekunder]);

  async function send() {
    setSender(true);
    setBesked(null);
    const svar = await gensendBekraeftelse(email);
    setSender(false);
    if ("fejl" in svar) {
      setBesked({ ok: false, tekst: svar.fejl });
      setSekunder(VENTETID_SEK);
      return;
    }
    setBesked({ ok: true, tekst: "Vi har sendt en ny mail. Tjek også din spam-mappe." });
    setSekunder(VENTETID_SEK);
  }

  const venter = sekunder > 0;
  const klasse =
    variant === "tekst"
      ? "inline-flex min-h-11 items-center rounded-md text-sm font-medium text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen disabled:text-tekst-svag disabled:no-underline"
      : "btn btn-sekundaer w-full sm:w-auto";

  return (
    <div>
      <button
        type="button"
        onClick={send}
        disabled={sender || venter || (email !== undefined && !email)}
        aria-busy={sender || undefined}
        className={klasse}
      >
        {sender && <span className="btn-spinner" aria-hidden="true" />}
        {venter ? `Send mailen igen (om ${sekunder} sek.)` : "Send mailen igen"}
      </button>
      <p aria-live="polite" className="min-h-0">
        {besked && (
          <span
            className={`mt-2 block text-[13px] font-medium ${besked.ok ? "text-succes-tekst" : "text-fejl-tekst"}`}
          >
            {besked.tekst}
          </span>
        )}
      </p>
    </div>
  );
}
