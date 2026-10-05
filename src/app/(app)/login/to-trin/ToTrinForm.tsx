"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { afbrydLogin, bekraeftToTrin } from "@/app/actions/auth";
import { FELT, FELT_FEJL, FORMULAR_FEJL, LABEL } from "@/components/konto/felter";

export default function ToTrinForm({ maal }: { maal: string }) {
  const router = useRouter();
  const [kode, setKode] = useState("");
  const [loading, setLoading] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFejl(null);
    setLoading(true);
    const svar = await bekraeftToTrin(kode);
    if ("fejl" in svar) {
      setLoading(false);
      setFejl(svar.fejl);
      setKode("");
      return;
    }
    router.push(maal);
    router.refresh();
  }

  async function annuller() {
    await afbrydLogin();
    router.push("/login");
    router.refresh();
  }

  return (
    <main className="flex flex-1 items-start justify-center px-4 py-8 sm:items-center sm:py-12">
      <div className="w-full max-w-sm">
        <div className="rounded-[14px] border border-kant bg-white p-5 shadow-kort sm:p-8">
          <h1 className="text-[26px] leading-tight sm:text-[32px]">Indtast din kode</h1>
          <p className="mt-1 text-sm text-tekst-daempet">
            Du har to-trins-login slået til. Åbn din godkendelses-app, og indtast den 6-cifrede kode for BidHamr.
          </p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div>
              <label htmlFor="kode" className={LABEL}>
                Kode fra appen
              </label>
              <input
                id="kode"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9 ]*"
                maxLength={7}
                required
                autoFocus
                value={kode}
                onChange={(e) => setKode(e.target.value.replace(/[^\d ]/g, ""))}
                aria-invalid={fejl ? true : undefined}
                className={`mt-1.5 ${FELT} text-center text-[20px] tracking-[0.3em] ${fejl ? FELT_FEJL : ""}`}
              />
            </div>

            {fejl && (
              <p role="alert" className={FORMULAR_FEJL}>
                {fejl}
              </p>
            )}

            <button
              type="submit"
              disabled={loading || kode.replace(/\s/g, "").length !== 6}
              aria-busy={loading || undefined}
              className="btn btn-primaer btn-stor w-full"
            >
              {loading && <span className="btn-spinner" aria-hidden="true" />}
              Log ind
            </button>
          </form>

          <div className="mt-6 border-t border-kant pt-4 text-sm text-tekst-daempet">
            <p>
              Har du mistet din telefon eller appen? Skriv til{" "}
              <a href="mailto:support@bidhamr.dk" className="font-medium text-groen hover:underline">
                support@bidhamr.dk
              </a>
              , så hjælper vi dig ind igen, når vi har bekræftet, at det er dig.
            </p>
            <button type="button" onClick={annuller} className="btn btn-tekst mt-3 min-h-11">
              Log ud og prøv igen
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
