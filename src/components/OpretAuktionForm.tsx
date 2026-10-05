"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { kategorier } from "@/lib/kategorier";
import {
  MAKS_BESKRIVELSE,
  MAKS_BILLEDER,
  MAKS_TITEL,
  MINDSTE_STARTPRIS,
  STANDARD_VARIGHED,
  STARTPRIS_ANBEFALING,
  VARIGHEDER,
  slutterKlFraVarighed,
  auktionBilledeSti,
  valideStartpris,
  type VarighedDage,
} from "@/lib/auktionRegler";

export default function OpretAuktionForm({ brugerId }: { brugerId: string }) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [billeder, setBilleder] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [titel, setTitel] = useState("");
  const [kategori, setKategori] = useState(kategorier[0]);
  const [beskrivelse, setBeskrivelse] = useState("");
  // Tomt felt fra start (ikke 0): mindste startpris er 1 kr.
  const [startpris, setStartpris] = useState<number>(NaN);
  const [varighed, setVarighed] = useState<VarighedDage>(STANDARD_VARIGHED);
  const [forsendelseMulig, setForsendelseMulig] = useState(false);
  const [postnummer, setPostnummer] = useState("");
  // Opslaget gemmes sammen med det postnummer, det hører til. By, koordinater
  // og status udledes ved render, så effekten kun sætter state i callbacks.
  const [opslag, setOpslag] = useState<{
    postnummer: string;
    by: string | null;
    koordinater: { lat: number; lng: number } | null;
    fundet: boolean;
  } | null>(null);
  const gyldigtPostnummer = /^\d{4}$/.test(postnummer);
  const aktueltOpslag =
    gyldigtPostnummer && opslag?.postnummer === postnummer ? opslag : null;
  const by = aktueltOpslag?.by ?? null;
  const koordinater = aktueltOpslag?.koordinater ?? null;
  const byStatus: "idle" | "henter" | "fundet" | "ikke-fundet" = !gyldigtPostnummer
    ? "idle"
    : !aktueltOpslag
      ? "henter"
      : aktueltOpslag.fundet
        ? "fundet"
        : "ikke-fundet";
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!/^\d{4}$/.test(postnummer)) return;

    const controller = new AbortController();

    fetch(`https://api.dataforsyningen.dk/postnumre/${postnummer}`, {
      signal: controller.signal,
    })
      .then((res) => {
        if (!res.ok) throw new Error("Postnummer ikke fundet");
        return res.json();
      })
      .then((data) => {
        setOpslag({
          postnummer,
          by: data.navn ?? null,
          koordinater: Array.isArray(data.visueltcenter)
            ? { lng: data.visueltcenter[0], lat: data.visueltcenter[1] }
            : null,
          fundet: true,
        });
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        setOpslag({ postnummer, by: null, koordinater: null, fundet: false });
      });

    return () => controller.abort();
  }, [postnummer]);

  function tilføjBilleder(files: FileList | null) {
    if (!files) return;
    const nye = Array.from(files).slice(0, MAKS_BILLEDER - billeder.length);
    if (nye.length === 0) return;

    setBilleder((prev) => [...prev, ...nye]);
    setPreviews((prev) => [
      ...prev,
      ...nye.map((file) => URL.createObjectURL(file)),
    ]);
  }

  function fjernBillede(index: number) {
    setBilleder((prev) => prev.filter((_, i) => i !== index));
    setPreviews((prev) => prev.filter((_, i) => i !== index));
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    tilføjBilleder(e.dataTransfer.files);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (billeder.length === 0) {
      setError("Tilføj mindst ét billede.");
      return;
    }
    const prisFejl = valideStartpris(startpris);
    if (prisFejl) {
      setError(prisFejl);
      return;
    }
    if (!/^\d{4}$/.test(postnummer)) {
      setError("Indtast et gyldigt postnummer (4 cifre).");
      return;
    }
    if (byStatus !== "fundet" || !by) {
      setError("Postnummeret kunne ikke findes – tjek at det er korrekt.");
      return;
    }

    setLoading(true);
    const supabase = createClient();

    try {
      // Brug den faktiske browser-session som autoritet for bruger-id'et,
      // i stedet for blindt at stole på prop'en fra serverkomponenten – hvis
      // sessionen er udløbet/mangler i browseren, fanger vi det her med en
      // klar besked, frem for at RLS bare afviser inserts/uploads tavst.
      const { data: sessionData, error: sessionError } =
        await supabase.auth.getUser();

      if (sessionError || !sessionData.user) {
        throw new Error(
          "Du er ikke logget ind længere. Log ind igen og prøv en gang til.",
        );
      }

      const aktuelBrugerId = sessionData.user.id;

      if (aktuelBrugerId !== brugerId) {
        console.warn(
          "Bruger-id fra server matcher ikke bruger-id fra browser-session.",
          { brugerIdFraServer: brugerId, brugerIdFraSession: aktuelBrugerId },
        );
      }

      const billedeUrls: string[] = [];

      for (const file of billeder) {
        const filnavn = auktionBilledeSti(aktuelBrugerId, file);
        const { error: uploadError } = await supabase.storage
          .from("auktion-billeder")
          .upload(filnavn, file);

        if (uploadError) {
          console.error("Billede-upload fejlede:", uploadError.message);
          throw new Error("Billedet kunne ikke uploades. Prøv igen om lidt.");
        }

        const { data: publicUrlData } = supabase.storage
          .from("auktion-billeder")
          .getPublicUrl(filnavn);

        billedeUrls.push(publicUrlData.publicUrl);
      }

      const slutterKl = slutterKlFraVarighed(varighed);

      const payload = {
        bruger_id: aktuelBrugerId,
        titel,
        beskrivelse: beskrivelse || null,
        billeder: billedeUrls,
        startpris,
        kategori,
        postnummer,
        lokation: by,
        lat: koordinater?.lat ?? null,
        lng: koordinater?.lng ?? null,
        forsendelse_mulig: forsendelseMulig,
        // Databasen beregner selv sluttidspunktet ud fra varigheden.
        varighed_dage: varighed,
        slutter_kl: slutterKl.toISOString(),
      };

      const { data, error: insertError } = await supabase
        .from("auctions")
        .insert(payload)
        .select("id")
        .single();

      if (insertError) {
        // Fx 42501 (trigger afviser låste felter) – brugeren får samme faste besked.
        console.error("Fejl ved oprettelse af auktion:", insertError.code, insertError.message);
        // BHU01: databasen kræver en udbetalingskonto (auctions_kraev_udbetalingskonto).
        // BHS02: kontoen er suspenderet (kraev_ikke_suspenderet).
        setError(
          insertError.code === "BHU01"
            ? "Du skal oprette en udbetalingskonto, før du kan sætte varer til salg."
            : insertError.code === "22023"
              ? "Tjek startpris og varighed (3, 5, 7 eller 10 dage), og prøv igen."
              : insertError.code === "BHA01"
                ? "Et af billederne kunne ikke bruges. Fjern det, tilføj det igen, og prøv igen."
                : insertError.code === "BHA02"
                  ? "Vælg en kategori."
                  : insertError.code === "BHS02"
                    ? "Din konto er suspenderet, og du kan ikke sætte varer til salg. Kontakt support@bidhamr.dk, hvis du mener, det er en fejl."
                    : "Auktionen kunne ikke oprettes. Prøv igen om lidt.",
        );
        setLoading(false);
        return;
      }

      router.push(`/auktion/${data.id}`);
    } catch (err) {
      console.error("Fejl ved oprettelse af auktion:", err);
      setError(err instanceof Error ? err.message : "Auktionen kunne ikke oprettes. Prøv igen om lidt.");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      {/* Billedupload */}
      <div>
        <label className="block text-sm font-medium text-neutral-900">
          Billeder
        </label>
        <p className="mt-1 text-xs text-neutral-500">
          Op til {MAKS_BILLEDER} billeder. Det første billede bliver
          forsidebillede.
        </p>

        <div
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          className={`mt-2 flex min-h-40 cursor-pointer flex-col items-center justify-center border-2 border-dashed px-4 py-8 text-center ${
            dragOver ? "border-brand bg-red-50" : "border-neutral-300"
          }`}
        >
          <svg
            viewBox="0 0 24 24"
            className="h-8 w-8 text-neutral-400"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 16V4m0 0L7 9m5-5l5 5M4 20h16"
            />
          </svg>
          <p className="mt-2 text-sm text-neutral-600">
            Klik eller træk billeder herind
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => tilføjBilleder(e.target.files)}
          />
        </div>

        {previews.length > 0 && (
          <div className="mt-3 grid grid-cols-4 gap-2 sm:grid-cols-5">
            {previews.map((src, index) => (
              <div key={src} className="relative aspect-square">
                <img
                  src={src}
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
          </div>
        )}
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
          className="mt-1.5 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-sm text-neutral-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand"
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
          className="mt-1.5 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-sm text-neutral-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand"
        >
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
          className="mt-1.5 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-sm text-neutral-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand"
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
          min={MINDSTE_STARTPRIS}
          step={1}
          required
          placeholder="Mindst 1 kr."
          value={Number.isNaN(startpris) ? "" : startpris}
          onChange={(e) => setStartpris(e.target.value === "" ? NaN : Number(e.target.value))}
          aria-describedby="startpris-hjaelp"
          className="mt-1.5 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-sm text-neutral-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand"
        />
        <p id="startpris-hjaelp" className="mt-1.5 text-xs text-neutral-500">
          {STARTPRIS_ANBEFALING} Startprisen er også den laveste pris, du sælger til.
        </p>
      </div>

      {/* Varighed */}
      <div>
        <label className="block text-sm font-medium text-neutral-900">
          Varighed
        </label>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {VARIGHEDER.map((v) => (
            <button
              key={v.dage}
              type="button"
              onClick={() => setVarighed(v.dage)}
              className={`rounded-lg border px-4 py-2 text-sm font-medium ${
                varighed === v.dage
                  ? "border-brand bg-orange-knap text-white"
                  : "border-neutral-300 text-neutral-700"
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-neutral-500">
          Varigheden kan ikke ændres, når auktionen er oprettet.
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
            forsendelseMulig ? "bg-brand" : "bg-neutral-300"
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
              forsendelseMulig ? "translate-x-5" : ""
            }`}
          />
        </button>
      </div>

      {/* Postnummer */}
      <div>
        <label htmlFor="postnummer" className="block text-sm font-medium text-neutral-900">
          Postnummer
        </label>
        <input
          id="postnummer"
          type="text"
          inputMode="numeric"
          maxLength={4}
          required
          value={postnummer}
          onChange={(e) => setPostnummer(e.target.value.replace(/\D/g, "").slice(0, 4))}
          placeholder="f.eks. 8000"
          className="mt-1.5 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-sm text-neutral-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand"
        />

        {byStatus === "henter" && (
          <p className="mt-1.5 text-sm text-neutral-500">Henter by…</p>
        )}
        {byStatus === "fundet" && by && (
          <p className="mt-1.5 text-sm text-neutral-700">📍 {by}</p>
        )}
        {byStatus === "ikke-fundet" && (
          <p className="mt-1.5 text-sm text-red-600">
            Postnummeret kunne ikke findes.
          </p>
        )}
      </div>

      {error && (
        <div className="border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-lg bg-orange-knap px-4 py-3 text-sm font-semibold text-white hover:bg-orange-knap-mork disabled:opacity-50"
      >
        {loading ? "Opretter auktion…" : "Opret auktion"}
      </button>
    </form>
  );
}
