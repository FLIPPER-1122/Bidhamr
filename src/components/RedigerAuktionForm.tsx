"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { kategorier } from "@/lib/kategorier";
import { redigerAuktion } from "@/app/actions/auktion";
import {
  MAKS_BESKRIVELSE,
  MAKS_BILLEDER,
  MAKS_TITEL,
  MINDSTE_STARTPRIS,
  STARTPRIS_ANBEFALING,
  auktionBilledeSti,
  valideStartpris,
} from "@/lib/auktionRegler";

// Samme felter og stil som OpretAuktionForm. Postnummer og varighed kan ikke
// ændres. Nye billeder uploades i browseren til sælgerens egen mappe; selve
// ændringen gemmes på serveren (redigerAuktion -> rediger_auktion), som
// afviser den, hvis der er kommet et bud imens.

type Billede =
  | { slags: "gemt"; url: string }
  | { slags: "ny"; fil: File; preview: string };

function billedeNoegle(b: Billede) {
  return b.slags === "gemt" ? b.url : b.preview;
}

export default function RedigerAuktionForm({
  auktionId,
  brugerId,
  start,
}: {
  auktionId: string;
  brugerId: string;
  start: {
    titel: string;
    beskrivelse: string;
    billeder: string[];
    kategori: string;
    startpris: number;
    forsendelseMulig: boolean;
  };
}) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [billeder, setBilleder] = useState<Billede[]>(
    start.billeder.map((url) => ({ slags: "gemt", url })),
  );
  const [titel, setTitel] = useState(start.titel);
  const [kategori, setKategori] = useState(
    kategorier.includes(start.kategori) ? start.kategori : "",
  );
  const [beskrivelse, setBeskrivelse] = useState(start.beskrivelse);
  const [startpris, setStartpris] = useState(start.startpris);
  const [forsendelseMulig, setForsendelseMulig] = useState(start.forsendelseMulig);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function tilføjBilleder(files: FileList | null) {
    if (!files) return;
    const nye = Array.from(files).slice(0, MAKS_BILLEDER - billeder.length);
    if (nye.length === 0) return;
    setBilleder((prev) => [
      ...prev,
      ...nye.map((fil) => ({ slags: "ny" as const, fil, preview: URL.createObjectURL(fil) })),
    ]);
  }

  function fjernBillede(index: number) {
    setBilleder((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (billeder.length === 0) {
      setError("Tilføj mindst ét billede.");
      return;
    }
    if (!titel.trim()) {
      setError("Skriv en titel.");
      return;
    }
    if (!kategori) {
      setError("Vælg en kategori.");
      return;
    }
    // En gammel auktion med startpris 0 må beholde den uændret (databasen
    // tjekker kun mindst 1 kr, når startprisen ændres).
    const prisFejl = startpris === start.startpris && startpris === 0 ? null : valideStartpris(startpris);
    if (prisFejl) {
      setError(prisFejl);
      return;
    }

    setLoading(true);
    const supabase = createClient();

    try {
      const urls: string[] = [];
      for (const b of billeder) {
        if (b.slags === "gemt") {
          urls.push(b.url);
          continue;
        }
        const filnavn = auktionBilledeSti(brugerId, b.fil);
        const { error: uploadError } = await supabase.storage
          .from("auktion-billeder")
          .upload(filnavn, b.fil);
        if (uploadError) {
          console.error("Billede-upload fejlede:", uploadError.message);
          setError("Billedet kunne ikke uploades. Prøv igen om lidt.");
          setLoading(false);
          return;
        }
        urls.push(supabase.storage.from("auktion-billeder").getPublicUrl(filnavn).data.publicUrl);
      }

      const svar = await redigerAuktion(auktionId, {
        titel,
        beskrivelse: beskrivelse || null,
        billeder: urls,
        kategori,
        startpris,
        forsendelseMulig,
      });

      if ("fejl" in svar) {
        setError(svar.fejl);
        setLoading(false);
        return;
      }

      router.push(`/auktion/${auktionId}`);
      router.refresh();
    } catch (err) {
      console.error("Fejl ved redigering af auktion:", err);
      setError("Ændringerne kunne ikke gemmes. Prøv igen om lidt.");
      setLoading(false);
    }
  }

  const feltKlasse =
    "mt-1.5 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-sm text-neutral-900 outline-none focus:border-groen focus:ring-1 focus:ring-groen";

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      <p className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600">
        Du kan ændre auktionen, indtil der kommer det første bud. Varigheden og
        postnummeret kan ikke ændres.
      </p>

      {/* Billeder */}
      <div>
        <span className="block text-sm font-medium text-neutral-900">Billeder</span>
        <p className="mt-1 text-xs text-neutral-500">
          Op til {MAKS_BILLEDER} billeder. Det første billede bliver forsidebillede.
        </p>

        <div className="mt-3 grid grid-cols-4 gap-2 sm:grid-cols-5">
          {billeder.map((b, index) => (
            <div key={billedeNoegle(b)} className="relative aspect-square">
              <img
                src={b.slags === "gemt" ? b.url : b.preview}
                alt={`Billede ${index + 1}`}
                className="h-full w-full object-cover"
              />
              {index === 0 && (
                <span className="absolute bottom-1 left-1 bg-orange-knap px-1.5 py-0.5 text-[10px] font-semibold text-white">
                  Forside
                </span>
              )}
              <button
                type="button"
                onClick={() => fjernBillede(index)}
                aria-label="Fjern billede"
                className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-white/90 text-xs text-neutral-700"
              >
                ×
              </button>
            </div>
          ))}
          {billeder.length < MAKS_BILLEDER && (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex aspect-square items-center justify-center border-2 border-dashed border-neutral-300 text-2xl text-neutral-400 hover:border-groen"
              aria-label="Tilføj billeder"
            >
              +
            </button>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            tilføjBilleder(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {/* Titel */}
      <div>
        <label htmlFor="titel" className="block text-sm font-medium text-neutral-900">
          Titel
        </label>
        <input
          id="titel"
          type="text"
          required
          maxLength={MAKS_TITEL}
          value={titel}
          onChange={(e) => setTitel(e.target.value)}
          className={feltKlasse}
        />
      </div>

      {/* Kategori */}
      <div>
        <label htmlFor="kategori" className="block text-sm font-medium text-neutral-900">
          Kategori
        </label>
        <select
          id="kategori"
          value={kategori}
          onChange={(e) => setKategori(e.target.value)}
          className={feltKlasse}
        >
          {!kategori && <option value="">Vælg kategori</option>}
          {kategorier.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </div>

      {/* Beskrivelse */}
      <div>
        <label htmlFor="beskrivelse" className="block text-sm font-medium text-neutral-900">
          Beskrivelse <span className="text-neutral-400">(valgfri)</span>
        </label>
        <textarea
          id="beskrivelse"
          rows={4}
          maxLength={MAKS_BESKRIVELSE}
          value={beskrivelse}
          onChange={(e) => setBeskrivelse(e.target.value)}
          className={feltKlasse}
        />
        <p className="mt-1 text-right text-xs text-neutral-400">
          {beskrivelse.length}/{MAKS_BESKRIVELSE}
        </p>
      </div>

      {/* Startpris */}
      <div>
        <label htmlFor="startpris" className="block text-sm font-medium text-neutral-900">
          Startpris (kr.)
        </label>
        <input
          id="startpris"
          type="number"
          inputMode="numeric"
          min={Math.min(MINDSTE_STARTPRIS, start.startpris)}
          step={1}
          required
          value={Number.isNaN(startpris) ? "" : startpris}
          onChange={(e) => setStartpris(e.target.value === "" ? NaN : Number(e.target.value))}
          aria-describedby="startpris-hjaelp"
          className={feltKlasse}
        />
        <p id="startpris-hjaelp" className="mt-1.5 text-xs text-neutral-500">
          {STARTPRIS_ANBEFALING} Startprisen er også den laveste pris, du sælger til.
        </p>
      </div>

      {/* Forsendelse */}
      <div className="flex items-center justify-between">
        <label htmlFor="forsendelse" className="text-sm font-medium text-neutral-900">
          Jeg tilbyder forsendelse mod betaling
        </label>
        <button
          id="forsendelse"
          type="button"
          role="switch"
          aria-checked={forsendelseMulig}
          onClick={() => setForsendelseMulig(!forsendelseMulig)}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
            forsendelseMulig ? "bg-groen" : "bg-neutral-300"
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
              forsendelseMulig ? "translate-x-5" : ""
            }`}
          />
        </button>
      </div>

      {error && (
        <div role="alert" className="border border-fejl-kant bg-fejl-bg px-4 py-3 text-sm text-fejl-tekst">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-lg bg-orange-knap px-4 py-3 text-sm font-semibold text-white hover:bg-orange-knap-mork disabled:opacity-50"
      >
        {loading ? "Gemmer…" : "Gem ændringer"}
      </button>
    </form>
  );
}
