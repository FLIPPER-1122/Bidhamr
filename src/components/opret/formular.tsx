"use client";

// Fælles byggesten til opret- og redigeringsformularen (DESIGN.md afsnit 6 og 8).
import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { MAKS_BILLEDER } from "@/lib/auktionRegler";
import { BilledFejl, erBillede, klargoerBillede } from "@/lib/billedBehandling";
import { STAND_VALG } from "@/lib/stand";

export const feltKlasse = (fejl?: boolean) =>
  `h-11 w-full rounded-xl border bg-white px-4 text-[15px] text-tekst placeholder:text-pladsholder hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25 ${
    fejl ? "border-fejl-kant bg-fejl-bg/40" : "border-kant-staerk"
  }`;

export const tekstfeltKlasse = (fejl?: boolean) =>
  `min-h-[120px] w-full rounded-xl border bg-white px-4 py-3 text-[15px] text-tekst placeholder:text-pladsholder hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25 ${
    fejl ? "border-fejl-kant bg-fejl-bg/40" : "border-kant-staerk"
  }`;

export const primaerKnap =
  "inline-flex h-[52px] w-full items-center justify-center gap-2 rounded-lg bg-orange-knap px-6 text-[15px] font-semibold text-white transition-colors hover:bg-orange-knap-mork active:scale-[.99] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen disabled:cursor-not-allowed disabled:bg-orange-knap/40 disabled:text-white/80 sm:h-11 sm:w-auto sm:px-5";

export const sekundaerKnap =
  "inline-flex h-[52px] w-full items-center justify-center gap-2 rounded-lg border border-groen bg-white px-6 text-[15px] font-semibold text-groen transition-colors hover:bg-groen-lys focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen disabled:cursor-not-allowed disabled:border-kant-staerk disabled:text-tekst-svag sm:h-11 sm:w-auto sm:px-5";

export function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
    />
  );
}

export function FeltFejl({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="mt-1.5 flex items-start gap-1 text-[13px] font-medium text-fejl-tekst">
      <svg viewBox="0 0 24 24" className="mt-px h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path strokeLinecap="round" d="M12 8v5M12 16h.01" />
      </svg>
      <span>{children}</span>
    </p>
  );
}

export function Hjaelp({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="mt-1.5 text-[13px] text-tekst-daempet">
      {children}
    </p>
  );
}

// Nummereret sektion ("1. Billeder").
export function Sektion({
  nr,
  titel,
  id,
  children,
}: {
  nr: number;
  titel: string;
  id: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="rounded-[14px] border border-kant bg-white p-4 sm:p-6">
      <h2 id={id} className="flex items-center gap-3 font-serif text-[17px] font-semibold text-tekst sm:text-lg">
        <span
          aria-hidden="true"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-groen-lys font-sans text-[13px] font-semibold text-groen-mork"
        >
          {nr}
        </span>
        {titel}
      </h2>
      <div className="mt-4 space-y-5">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------- Billeder

export type Billede =
  | { slags: "gemt"; noegle: string; url: string }
  | { slags: "ny"; noegle: string; status: "behandler" }
  | { slags: "ny"; noegle: string; status: "klar"; fil: File; preview: string };

let naesteNoegle = 0;
const nyNoegle = () => `b${Date.now()}-${naesteNoegle++}`;

export function billedeKlar(b: Billede): boolean {
  return b.slags === "gemt" || b.status === "klar";
}

// Vælg, træk ind, fjern og vælg forsidebillede. Billeder komprimeres, så snart
// de er valgt (HEIC -> JPEG, maks 2000 px, ~80 %).
export function BilledVaelger({
  billeder,
  setBilleder,
  fejl,
  fejlId,
}: {
  billeder: Billede[];
  setBilleder: (fn: (prev: Billede[]) => Billede[]) => void;
  fejl?: string | null;
  fejlId: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [behandlingsFejl, setBehandlingsFejl] = useState<string[]>([]);
  const plads = MAKS_BILLEDER - billeder.length;

  async function tilfoej(files: FileList | File[] | null) {
    if (!files) return;
    const alle = Array.from(files);
    const valgte = alle.filter(erBillede);
    const fejlListe: string[] = [];
    if (valgte.length < alle.length) fejlListe.push("Nogle af filerne er ikke billeder og blev sprunget over.");
    if (valgte.length > plads) {
      fejlListe.push(`Du kan højst have ${MAKS_BILLEDER} billeder. De sidste blev ikke tilføjet.`);
    }
    const nye = valgte.slice(0, Math.max(0, plads)).map((fil) => ({ fil, noegle: nyNoegle() }));
    setBehandlingsFejl(fejlListe);
    if (nye.length === 0) return;

    setBilleder((prev) => [
      ...prev,
      ...nye.map((n) => ({ slags: "ny" as const, noegle: n.noegle, status: "behandler" as const })),
    ]);

    // Ét ad gangen - store billeder fylder meget i hukommelsen på telefoner.
    for (const n of nye) {
      try {
        const fil = await klargoerBillede(n.fil);
        const preview = URL.createObjectURL(fil);
        // Er billedet fjernet imens, findes nøglen ikke længere, og intet ændres.
        setBilleder((prev) =>
          prev.map((b) =>
            b.noegle === n.noegle ? { slags: "ny" as const, noegle: n.noegle, status: "klar" as const, fil, preview } : b,
          ),
        );
      } catch (err) {
        const besked =
          err instanceof BilledFejl ? err.message : `"${n.fil.name}" kunne ikke behandles. Prøv et andet billede.`;
        setBehandlingsFejl((f) => [...f, besked]);
        setBilleder((prev) => prev.filter((b) => b.noegle !== n.noegle));
      }
    }
  }

  function fjern(noegle: string) {
    setBilleder((prev) => {
      const b = prev.find((x) => x.noegle === noegle);
      if (b && b.slags === "ny" && b.status === "klar") URL.revokeObjectURL(b.preview);
      return prev.filter((x) => x.noegle !== noegle);
    });
  }

  function goerTilForside(noegle: string) {
    setBilleder((prev) => {
      const b = prev.find((x) => x.noegle === noegle);
      return b ? [b, ...prev.filter((x) => x.noegle !== noegle)] : prev;
    });
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    void tilfoej(e.dataTransfer.files);
  }

  const behandler = billeder.some((b) => b.slags === "ny" && b.status === "behandler");

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`rounded-xl border-2 border-dashed p-4 text-center transition-colors ${
          dragOver ? "border-groen bg-groen-lys" : fejl ? "border-fejl-kant bg-fejl-bg/40" : "border-kant-staerk"
        }`}
      >
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={plads <= 0}
          aria-describedby={`${fejlId}-hjaelp${fejl ? ` ${fejlId}` : ""}`}
          className={sekundaerKnap}
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0L7 9m5-5l5 5M4 20h16" />
          </svg>
          {billeder.length === 0 ? "Vælg billeder" : "Tilføj flere billeder"}
        </button>
        <p id={`${fejlId}-hjaelp`} className="mt-2 text-[13px] text-tekst-daempet">
          Op til {MAKS_BILLEDER} billeder ({billeder.length}/{MAKS_BILLEDER}). JPEG, PNG og iPhone-billeder (HEIC).
          Billederne gøres automatisk mindre, før de sendes. <span className="hidden sm:inline">Du kan også trække dem herind.</span>
        </p>
        <input
          ref={inputRef}
          type="file"
          accept="image/*,.heic,.heif"
          multiple
          className="hidden"
          onChange={(e) => {
            void tilfoej(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {behandler && (
        <p role="status" className="mt-2 flex items-center gap-2 text-[13px] text-tekst-daempet">
          <Spinner /> Gør billederne klar …
        </p>
      )}
      {behandlingsFejl.map((f, i) => (
        <FeltFejl key={i} id={`${fejlId}-behandling-${i}`}>
          {f}
        </FeltFejl>
      ))}
      {fejl && <FeltFejl id={fejlId}>{fejl}</FeltFejl>}

      {billeder.length > 0 && (
        <ul className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5">
          {billeder.map((b, i) => (
            <li key={b.noegle} className="relative aspect-square overflow-hidden rounded-lg bg-skelet">
              {billedeKlar(b) ? (
                // eslint-disable-next-line @next/next/no-img-element -- lokale blob-URL'er
                <img
                  src={b.slags === "gemt" ? b.url : b.status === "klar" ? b.preview : ""}
                  alt={`Billede ${i + 1}${i === 0 ? " (forside)" : ""}`}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="grid h-full w-full place-items-center text-tekst-svag">
                  <Spinner />
                  <span className="sr-only">Behandler billede</span>
                </div>
              )}
              {i === 0 ? (
                <span className="absolute bottom-1 left-1 rounded-full bg-groen px-2 py-0.5 text-xs font-semibold text-white">
                  Forside
                </span>
              ) : (
                billedeKlar(b) && (
                  <button
                    type="button"
                    onClick={() => goerTilForside(b.noegle)}
                    className="absolute bottom-1 left-1 rounded-full bg-white/95 px-2 py-1 text-xs font-medium text-groen-mork focus-visible:outline-2 focus-visible:outline-groen"
                  >
                    Gør til forside
                  </button>
                )
              )}
              <button
                type="button"
                onClick={() => fjern(b.noegle)}
                aria-label={`Fjern billede ${i + 1}`}
                className="absolute top-1 right-1 grid h-9 w-9 place-items-center rounded-full bg-white/95 text-tekst focus-visible:outline-2 focus-visible:outline-groen"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                  <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Stand

export function StandVaelger({
  vaerdi,
  onChange,
  fejl,
  fejlId,
}: {
  vaerdi: string;
  onChange: (v: string) => void;
  fejl?: string | null;
  fejlId: string;
}) {
  return (
    <fieldset aria-describedby={fejl ? fejlId : undefined}>
      <legend className="mb-1.5 text-sm font-medium text-tekst">Stand</legend>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {STAND_VALG.map((s) => {
          const valgt = vaerdi === s.kode;
          return (
            <label
              key={s.kode}
              className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-groen ${
                valgt ? "border-groen bg-groen-lys" : fejl ? "border-fejl-kant" : "border-kant-staerk hover:border-[#BFBFBF]"
              }`}
            >
              <input
                type="radio"
                name="stand"
                value={s.kode}
                checked={valgt}
                onChange={() => onChange(s.kode)}
                className="mt-0.5 h-5 w-5 shrink-0 accent-groen"
              />
              <span>
                <span className="block text-[15px] font-semibold text-tekst">{s.navn}</span>
                <span className="block text-[13px] text-tekst-daempet">{s.beskrivelse}</span>
              </span>
            </label>
          );
        })}
      </div>
      {fejl && <FeltFejl id={fejlId}>{fejl}</FeltFejl>}
    </fieldset>
  );
}

// ---------------------------------------------------------------- Afkrydsning

export function Afkrydsning({
  id,
  checked,
  onChange,
  children,
  hjaelp,
  fejl,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
  hjaelp?: ReactNode;
  fejl?: string | null;
}) {
  return (
    <div>
      <label htmlFor={id} className="flex min-h-11 cursor-pointer items-start gap-3 py-1">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          aria-invalid={fejl ? true : undefined}
          aria-describedby={[hjaelp ? `${id}-hjaelp` : "", fejl ? `${id}-fejl` : ""].filter(Boolean).join(" ") || undefined}
          className="mt-0.5 h-5 w-5 shrink-0 rounded-[6px] accent-groen"
        />
        <span className="text-[15px] text-tekst">{children}</span>
      </label>
      {hjaelp && (
        <p id={`${id}-hjaelp`} className="ml-8 text-[13px] text-tekst-daempet">
          {hjaelp}
        </p>
      )}
      {fejl && (
        <div className="ml-8">
          <FeltFejl id={`${id}-fejl`}>{fejl}</FeltFejl>
        </div>
      )}
    </div>
  );
}
