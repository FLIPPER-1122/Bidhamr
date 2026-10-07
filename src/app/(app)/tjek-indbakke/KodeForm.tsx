"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { verificerSignupKode } from "@/app/actions/auth";
import GensendBekraeftelse from "@/components/konto/GensendBekraeftelse";
import { FELT, FELT_FEJL, FORMULAR_FEJL, LABEL } from "@/components/konto/felter";

// Indtast den 6-cifrede kode fra bekræftelsesmailen. Ét felt (så indsæt fra
// udklipsholderen og iOS/Android's "udfyld fra mail" virker). Kendes e-mailen
// fra cookien (signup eller login med ubekræftet e-mail), vises den bare -
// ellers skal den skrives. Koden verificeres på serveren med rate limit
// (verificerSignupKode i src/app/actions/auth.ts).
export default function KodeForm({ kendtEmail, startVentetid }: { kendtEmail: string | null; startVentetid: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [kode, setKode] = useState("");
  const [sender, setSender] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);

  function opdaterKode(v: string) {
    // Tillad mellemrum og bindestreger ved indsæt ("123 456"), men gem kun
    // cifre. Koden er 6 cifre i produktion; op til 10 tillades, fordi
    // længden er en indstilling i Supabase (testdatabasen bruger 8).
    setKode(v.replace(/\D/g, "").slice(0, 10));
    setFejl(null);
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    if (kode.length < 6) {
      setFejl("Koden består af 6 cifre.");
      return;
    }
    setSender(true);
    setFejl(null);
    const svar = await verificerSignupKode(kode, kendtEmail ? undefined : email.trim());
    if ("fejl" in svar) {
      setSender(false);
      setFejl(svar.fejl);
      return;
    }
    router.push("/velkommen");
    router.refresh();
  }

  return (
    <div className="w-full">
      <form onSubmit={send} className="space-y-4" noValidate>
        {!kendtEmail && (
          <div>
            <label htmlFor="kode-email" className={LABEL}>
              Din e-mail
            </label>
            <input
              id="kode-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={`mt-1.5 ${FELT}`}
            />
          </div>
        )}

        <div>
          <label htmlFor="kode" className={LABEL}>
            Kode fra mailen
          </label>
          <input
            id="kode"
            name="kode"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={16}
            required
            autoFocus
            value={kode}
            onChange={(e) => opdaterKode(e.target.value)}
            aria-invalid={fejl ? true : undefined}
            aria-describedby={fejl ? "kode-fejl" : "kode-hjaelp"}
            className={`mt-1.5 ${FELT} h-14 text-center text-[24px] font-semibold tracking-[0.4em] ${fejl ? FELT_FEJL : ""}`}
          />
          <p id="kode-hjaelp" className="mt-1.5 text-[13px] text-tekst-daempet">
            6 cifre. Koden udløber 1 time efter, mailen er sendt.
          </p>
        </div>

        {fejl && (
          <p id="kode-fejl" role="alert" className={FORMULAR_FEJL}>
            {fejl}
          </p>
        )}

        <button
          type="submit"
          disabled={sender || kode.length < 6 || (!kendtEmail && !email.trim())}
          aria-busy={sender || undefined}
          className="btn btn-primaer btn-stor w-full"
        >
          {sender && <span className="btn-spinner" aria-hidden="true" />}
          Bekræft e-mail
        </button>
      </form>

      <div className="mt-5 flex flex-col items-center">
        <GensendBekraeftelse
          email={kendtEmail ? undefined : email.trim()}
          startVentetid={startVentetid}
          variant="tekst"
        />
      </div>
    </div>
  );
}
