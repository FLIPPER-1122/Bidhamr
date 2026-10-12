"use client";

// Formularen bag "Meld fejl" (beta-testen). Hentes først, når knappen trykkes
// (dynamic import i BetaFejlStarter), og Supabase-klienten hentes først, når
// der skal uploades et billede.
//
// Billederne klargøres i browseren (JPEG, højst 2000 px, uden EXIF - se
// src/lib/billedBehandling.ts) og uploades til brugerens egen mappe i den
// private bucket 'beta-fejl-billeder'. Siden, browseren og skærmstørrelsen
// sendes med automatisk.
import { useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { indsendBetaFejl } from "@/app/actions/betaFejl";
import { BilledFejl, erBillede, klargoerBillede } from "@/lib/billedBehandling";
import {
  ALVOR_NAVN,
  BETA_FEJL_ALVOR,
  BETA_FEJL_BUCKET,
  BETA_FEJL_MAKS_BILLEDER,
  BETA_FEJL_MAKS_FORVENTET,
  BETA_FEJL_MAKS_MB,
  BETA_FEJL_MAKS_TEKST,
  betaFejlBilledeSti,
  type BetaFejlAlvor,
} from "@/lib/betaFejl";

type Billede = { id: string; fil: File; url: string };

const NETVAERK = "Fejlen kunne ikke sendes. Tjek din forbindelse, og prøv igen.";

function skaermTekst(): string {
  const dpr = Math.round((window.devicePixelRatio || 1) * 100) / 100;
  return `vindue ${window.innerWidth}x${window.innerHeight}, skærm ${window.screen.width}x${window.screen.height}, ${dpr}x`;
}

export default function BetaFejlFormular({ brugerId, onLuk }: { brugerId: string; onLuk: () => void }) {
  const id = useId();
  const pathname = usePathname();
  const [alvor, setAlvor] = useState<BetaFejlAlvor | null>(null);
  const [tekst, setTekst] = useState("");
  const [forventet, setForventet] = useState("");
  const [billeder, setBilleder] = useState<Billede[]>([]);
  const [klargoer, setKlargoer] = useState(false);
  const [sender, setSender] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const [billedFejl, setBilledFejl] = useState<string | null>(null);
  const [sendt, setSendt] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const fejlRef = useRef<HTMLParagraphElement>(null);
  const filRef = useRef<HTMLInputElement>(null);
  // Stier, der allerede er uploadet (så et nyt forsøg efter en fejl ikke
  // uploader samme billede igen).
  const uploadet = useRef(new Map<string, string>());
  const billederRef = useRef<Billede[]>([]);
  useEffect(() => {
    billederRef.current = billeder;
  }, [billeder]);

  const travl = sender || klargoer;

  // Esc lukker (ikke midt i en afsendelse), og baggrunden scroller ikke.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !sender) onLuk();
    };
    window.addEventListener("keydown", onKey);
    const forrige = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = forrige;
    };
  }, [onLuk, sender]);

  // Fokus ind i dialogen ved åbning.
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>("input, textarea, button")?.focus();
  }, [sendt]);

  // Ryd forhåndsvisningerne op, når dialogen lukkes.
  useEffect(() => () => billederRef.current.forEach((b) => URL.revokeObjectURL(b.url)), []);

  async function vaelgBilleder(filer: FileList | null) {
    setBilledFejl(null);
    if (!filer || filer.length === 0) return;
    const plads = BETA_FEJL_MAKS_BILLEDER - billeder.length;
    const valgte = Array.from(filer);
    if (valgte.length > plads) {
      setBilledFejl(`Du kan højst vedhæfte ${BETA_FEJL_MAKS_BILLEDER} billeder.`);
    }
    setKlargoer(true);
    const nye: Billede[] = [];
    try {
      for (const fil of valgte.slice(0, Math.max(0, plads))) {
        if (!erBillede(fil)) {
          setBilledFejl(`"${fil.name}" er ikke et billede.`);
          continue;
        }
        try {
          const klar = await klargoerBillede(fil);
          if (klar.size > BETA_FEJL_MAKS_MB * 1024 * 1024) {
            setBilledFejl(`"${fil.name}" er for stort (over ${BETA_FEJL_MAKS_MB} MB).`);
            continue;
          }
          nye.push({ id: crypto.randomUUID(), fil: klar, url: URL.createObjectURL(klar) });
        } catch (err) {
          setBilledFejl(err instanceof BilledFejl ? err.message : `"${fil.name}" kunne ikke læses.`);
        }
      }
    } finally {
      setBilleder((f) => [...f, ...nye].slice(0, BETA_FEJL_MAKS_BILLEDER));
      setKlargoer(false);
      if (filRef.current) filRef.current.value = "";
    }
  }

  function fjernBillede(b: Billede) {
    URL.revokeObjectURL(b.url);
    uploadet.current.delete(b.id);
    setBilleder((f) => f.filter((x) => x.id !== b.id));
  }

  async function uploadBilleder(): Promise<string[]> {
    if (billeder.length === 0) return [];
    const { createClient } = await import("@/lib/supabase/client");
    const supabase = createClient();
    const stier: string[] = [];
    for (const b of billeder) {
      const gemt = uploadet.current.get(b.id);
      if (gemt) {
        stier.push(gemt);
        continue;
      }
      const sti = betaFejlBilledeSti(brugerId);
      const { error } = await supabase.storage
        .from(BETA_FEJL_BUCKET)
        .upload(sti, b.fil, { contentType: "image/jpeg", upsert: false });
      if (error) {
        console.error("Beta-fejl: billede kunne ikke uploades:", error.message);
        throw new Error("Et billede kunne ikke uploades. Fjern det, eller prøv igen.");
      }
      uploadet.current.set(b.id, sti);
      stier.push(sti);
    }
    return stier;
  }

  function visFejl(besked: string) {
    setFejl(besked);
    requestAnimationFrame(() => fejlRef.current?.focus());
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (travl) return;
    setFejl(null);
    if (!alvor) return visFejl("Vælg, hvor slemt det er.");
    if (!tekst.trim()) return visFejl("Skriv, hvad du gjorde, og hvad der skete.");
    setSender(true);
    try {
      let stier: string[];
      try {
        stier = await uploadBilleder();
      } catch (err) {
        return visFejl(err instanceof Error ? err.message : NETVAERK);
      }
      const svar = await indsendBetaFejl({
        alvor,
        tekst,
        forventet: forventet.trim() || null,
        sti: pathname,
        browser: navigator.userAgent,
        skaerm: skaermTekst(),
        billeder: stier,
      });
      if ("fejl" in svar) return visFejl(svar.fejl);
      billeder.forEach((b) => URL.revokeObjectURL(b.url));
      setBilleder([]);
      uploadet.current.clear();
      setSendt(true);
    } catch (err) {
      console.error("Beta-fejl: afsendelse fejlede:", err);
      visFejl(NETVAERK);
    } finally {
      setSender(false);
    }
  }

  function nyFejl() {
    setAlvor(null);
    setTekst("");
    setForventet("");
    setFejl(null);
    setBilledFejl(null);
    setSendt(false);
  }

  const feltKlasse =
    "w-full rounded-xl border border-kant-staerk bg-white px-4 py-3 text-[15px] text-tekst placeholder:text-pladsholder hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25";

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-end sm:justify-end sm:p-6 print:hidden">
      <div className="absolute inset-0 bg-black/30" aria-hidden="true" onClick={() => !sender && onLuk()} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-titel`}
        className="relative flex max-h-[92svh] w-full flex-col overflow-hidden rounded-t-[18px] bg-white shadow-[var(--shadow-stor)] sm:max-h-[min(720px,calc(100svh-48px))] sm:w-[420px] sm:rounded-[18px]"
      >
        <div className="flex items-start justify-between gap-3 border-b border-kant px-5 pt-4 pb-3">
          <div>
            <h2 id={`${id}-titel`} className="text-lg text-tekst">
              Meld en fejl
            </h2>
            <p className="mt-0.5 text-[13px] text-tekst-daempet">Kun for beta-testere. Tak for hjælpen.</p>
          </div>
          <button
            type="button"
            onClick={onLuk}
            disabled={sender}
            aria-label="Luk"
            className="-mr-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-tekst-daempet hover:bg-groen-lys disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true" focusable="false">
              <path d="M18 6l-12 12" />
              <path d="M6 6l12 12" />
            </svg>
          </button>
        </div>

        {sendt ? (
          <div className="space-y-4 px-5 py-6 pb-[max(24px,env(safe-area-inset-bottom))]">
            <div role="status" className="rounded-xl border border-succes-kant bg-succes-bg p-4 text-sm text-succes-tekst">
              {/* TODO(indhold): tak-teksten. */}
              <p className="font-semibold">Tak! Vi har fået din fejlmelding.</p>
              <p className="mt-1">Vi kigger på den hurtigst muligt.</p>
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button type="button" onClick={nyFejl} className="btn btn-sekundaer">
                Meld en fejl mere
              </button>
              <button type="button" onClick={onLuk} className="btn btn-primaer">
                Luk
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={send} method="post" noValidate className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
              {fejl && (
                <p
                  ref={fejlRef}
                  tabIndex={-1}
                  role="alert"
                  className="rounded-xl border border-fejl-kant bg-fejl-bg p-3 text-sm text-fejl-tekst outline-none"
                >
                  {fejl}
                </p>
              )}

              <fieldset>
                <legend className="mb-1.5 text-sm font-medium text-tekst">Hvor slemt er det?</legend>
                <div className="space-y-1">
                  {BETA_FEJL_ALVOR.map((a) => (
                    <label
                      key={a}
                      className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border px-3 text-[15px] ${
                        alvor === a ? "border-groen bg-groen-lys" : "border-kant hover:bg-neutral-50"
                      }`}
                    >
                      <input
                        type="radio"
                        name={`${id}-alvor`}
                        value={a}
                        checked={alvor === a}
                        onChange={() => setAlvor(a)}
                        className="h-5 w-5 accent-groen"
                      />
                      {ALVOR_NAVN[a]}
                    </label>
                  ))}
                </div>
              </fieldset>

              <div>
                <label htmlFor={`${id}-tekst`} className="mb-1.5 block text-sm font-medium text-tekst">
                  Hvad gjorde du, og hvad skete der?
                </label>
                <textarea
                  id={`${id}-tekst`}
                  value={tekst}
                  onChange={(e) => setTekst(e.target.value)}
                  maxLength={BETA_FEJL_MAKS_TEKST}
                  rows={4}
                  placeholder="Fx: Jeg trykkede på Byd, og siden blev hvid."
                  className={`${feltKlasse} min-h-[110px]`}
                />
              </div>

              <div>
                <label htmlFor={`${id}-forventet`} className="mb-1.5 block text-sm font-medium text-tekst">
                  Hvad havde du forventet? <span className="font-normal text-tekst-svag">(valgfrit)</span>
                </label>
                <textarea
                  id={`${id}-forventet`}
                  value={forventet}
                  onChange={(e) => setForventet(e.target.value)}
                  maxLength={BETA_FEJL_MAKS_FORVENTET}
                  rows={2}
                  className={`${feltKlasse} min-h-[72px]`}
                />
              </div>

              <div>
                <p className="mb-1.5 text-sm font-medium text-tekst">
                  Skærmbilleder <span className="font-normal text-tekst-svag">(valgfrit)</span>
                </p>
                {billeder.length > 0 && (
                  <ul className="mb-2 flex flex-wrap gap-2">
                    {billeder.map((b, i) => (
                      <li key={b.id} className="relative h-20 w-20 overflow-hidden rounded-lg border border-kant bg-skelet">
                        {/* Lokal forhåndsvisning (blob:), som ikke kan gå gennem next/image. */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={b.url} alt={`Skærmbillede ${i + 1}`} className="h-full w-full object-cover" />
                        <button
                          type="button"
                          onClick={() => fjernBillede(b)}
                          disabled={sender}
                          aria-label={`Fjern skærmbillede ${i + 1}`}
                          className="absolute top-0 right-0 inline-flex h-11 w-11 items-start justify-end p-1 disabled:opacity-50"
                        >
                          <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white">
                            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" aria-hidden="true" focusable="false">
                              <path d="M18 6l-12 12" />
                              <path d="M6 6l12 12" />
                            </svg>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {billeder.length < BETA_FEJL_MAKS_BILLEDER && (
                  <label
                    className={`btn btn-sekundaer cursor-pointer ${travl ? "pointer-events-none opacity-60" : ""}`}
                    aria-busy={klargoer || undefined}
                  >
                    {klargoer && <span className="btn-spinner" aria-hidden="true" />}
                    Vælg billede
                    <input
                      ref={filRef}
                      type="file"
                      accept="image/*"
                      multiple
                      disabled={travl}
                      onChange={(e) => void vaelgBilleder(e.target.files)}
                      className="sr-only"
                    />
                  </label>
                )}
                <p className="mt-1.5 text-[13px] text-tekst-daempet">
                  Højst {BETA_FEJL_MAKS_BILLEDER} billeder på højst {BETA_FEJL_MAKS_MB} MB hver.
                </p>
                {billedFejl && (
                  <p role="alert" className="mt-1.5 text-[13px] font-medium text-fejl-tekst">
                    {billedFejl}
                  </p>
                )}
              </div>

              {/* TODO(indhold): gennemse forklaringen. */}
              <p className="rounded-xl bg-groen-lys p-3 text-[13px] text-groen-mork">
                Vi sender automatisk siden ({pathname}), din browser og skærmstørrelse med. Skriv aldrig kortnummer,
                CPR-nummer eller adgangskoder.
              </p>
            </div>

            <div className="flex flex-col-reverse gap-2 border-t border-kant px-5 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] sm:flex-row sm:justify-end">
              <button type="button" onClick={onLuk} disabled={sender} className="btn btn-sekundaer">
                Annullér
              </button>
              <button type="submit" disabled={travl} aria-busy={sender || undefined} className="btn btn-primaer">
                {sender && <span className="btn-spinner" aria-hidden="true" />}
                Send fejl
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
