"use client";

// Firmaets oplysninger i admin (opret firmakonto og ret firma).
import { ADMIN_ERHVERV_EKSTRA as X } from "@/lib/tekster/erhverv";

export type FirmaVaerdier = {
  firmanavn: string;
  cvr: string;
  adresse: string;
  postnummer: string;
  by: string;
  telefon: string;
  kontaktEmail: string;
  kontaktperson: string;
};

export const ADMIN_FELT =
  "h-11 w-full rounded-xl border border-kant-staerk bg-white px-4 text-[15px] text-tekst focus:border-groen focus:outline-2 focus:outline-groen/25 read-only:border-transparent read-only:bg-groen-lys";
export const ADMIN_LABEL = "mb-1.5 block text-sm font-medium text-tekst";

const FELTER: { navn: keyof FirmaVaerdier; label: string; type?: string; inputMode?: "numeric" | "tel" | "email" }[] = [
  { navn: "firmanavn", label: X.felter.firmanavn },
  { navn: "cvr", label: X.felter.cvr, inputMode: "numeric" },
  { navn: "adresse", label: X.felter.adresse },
  { navn: "postnummer", label: X.felter.postnummer, inputMode: "numeric" },
  { navn: "by", label: X.felter.by },
  { navn: "kontaktperson", label: X.felter.kontaktperson },
  { navn: "telefon", label: X.felter.telefon, type: "tel", inputMode: "tel" },
  { navn: "kontaktEmail", label: X.felter.kontaktEmail, type: "email", inputMode: "email" },
];

export default function FirmaFelter({
  vaerdier,
  onChange,
  laaste = [],
  idPraefiks,
}: {
  vaerdier: FirmaVaerdier;
  onChange: (v: FirmaVaerdier) => void;
  // Felter, der kun kan læses (fx firmanavn og CVR for rollen saelger).
  laaste?: (keyof FirmaVaerdier)[];
  idPraefiks: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {FELTER.map((f) => {
        const id = `${idPraefiks}-${f.navn}`;
        return (
          <div key={f.navn} className={f.navn === "adresse" || f.navn === "kontaktEmail" ? "sm:col-span-2" : undefined}>
            <label htmlFor={id} className={ADMIN_LABEL}>
              {f.label}
            </label>
            <input
              id={id}
              type={f.type ?? "text"}
              inputMode={f.inputMode}
              value={vaerdier[f.navn]}
              readOnly={laaste.includes(f.navn)}
              onChange={(e) => onChange({ ...vaerdier, [f.navn]: e.target.value })}
              className={ADMIN_FELT}
            />
          </div>
        );
      })}
    </div>
  );
}
