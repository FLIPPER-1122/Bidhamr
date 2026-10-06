"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { kategorier } from "@/lib/kategorier";
import { redigerAuktion } from "@/app/actions/auktion";
import {
  MAKS_BESKRIVELSE,
  MAKS_TITEL,
  MINDSTE_STARTPRIS,
  STARTPRIS_ANBEFALING,
  valideStartpris,
} from "@/lib/auktionRegler";
import { forbudtBesked, tjekForbudtTekst } from "@/lib/forbudteVarer";
import { erStand } from "@/lib/stand";
import { uploadAuktionsbilleder } from "@/lib/auktionUpload";
import {
  Afkrydsning,
  BilledVaelger,
  FeltFejl,
  Hjaelp,
  Sektion,
  Spinner,
  StandVaelger,
  billedeKlar,
  feltKlasse,
  primaerKnap,
  tekstfeltKlasse,
  type Billede,
} from "@/components/opret/formular";

// Samme felter og byggesten som OpretAuktionForm. Postnummer og varighed kan
// ikke ændres. Nye billeder klargøres (HEIC -> JPEG, maks 2000 px) og uploades
// i browseren til sælgerens egen mappe; selve ændringen gemmes på serveren
// (redigerAuktion -> rediger_auktion), som afviser den, hvis der er kommet et
// bud imens.

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
    stand: string | null;
  };
}) {
  const router = useRouter();

  const [billeder, setBilleder] = useState<Billede[]>(
    start.billeder.map((url, i) => ({ slags: "gemt", noegle: `gemt-${i}-${url}`, url })),
  );
  const [titel, setTitel] = useState(start.titel);
  const [kategori, setKategori] = useState(kategorier.includes(start.kategori) ? start.kategori : "");
  const [beskrivelse, setBeskrivelse] = useState(start.beskrivelse);
  const [startprisTekst, setStartprisTekst] = useState(String(start.startpris));
  const [forsendelseMulig, setForsendelseMulig] = useState(start.forsendelseMulig);
  const [stand, setStand] = useState<string>(erStand(start.stand) ? start.stand : "");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const startpris = startprisTekst === "" ? NaN : Number(startprisTekst);
  // Som databasen (rediger_auktion): forbudte ord tjekkes kun, når teksten
  // er ændret.
  const tekstAendret = titel.trim() !== start.titel.trim() || beskrivelse.trim() !== start.beskrivelse.trim();
  const forbudt = tekstAendret ? tjekForbudtTekst(titel, beskrivelse) : null;
  const forbudtTekst = forbudt?.resultat === "blokeret" ? forbudtBesked(forbudt.ord, forbudt.kategori) : null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (billeder.length === 0) return setError("Tilføj mindst ét billede.");
    if (!billeder.every(billedeKlar)) return setError("Vent, til billederne er klar.");
    if (!titel.trim()) return setError("Skriv en titel.");
    if (forbudtTekst) return setError(forbudtTekst);
    if (!kategori) return setError("Vælg en kategori.");
    // Gamle auktioner uden stand må gemmes uden (databasen kræver den kun ved oprettelse).
    if (start.stand && !erStand(stand)) return setError("Vælg varens stand.");
    // En gammel auktion med startpris 0 må beholde den uændret (databasen
    // tjekker kun mindst 1 kr, når startprisen ændres).
    const prisFejl = startpris === start.startpris && startpris === 0 ? null : valideStartpris(startpris);
    if (prisFejl) return setError(prisFejl);

    setLoading(true);
    const supabase = createClient();

    try {
      const urls = await uploadAuktionsbilleder(
        supabase,
        brugerId,
        billeder.map((b) =>
          b.slags === "gemt" ? { url: b.url } : b.status === "klar" ? { fil: b.fil } : { url: "" },
        ),
        (nr, ialt) => setStatus(`Uploader billede ${nr} af ${ialt} …`),
      );
      setStatus("Gemmer …");

      const svar = await redigerAuktion(auktionId, {
        titel,
        beskrivelse: beskrivelse || null,
        billeder: urls,
        kategori,
        startpris,
        forsendelseMulig,
        stand: erStand(stand) ? stand : null,
      });

      if ("fejl" in svar) {
        setError(svar.fejl);
        setStatus(null);
        setLoading(false);
        return;
      }

      router.push(`/auktion/${auktionId}`);
      router.refresh();
    } catch (err) {
      console.error("Fejl ved redigering af auktion:", err);
      setError(err instanceof Error ? err.message : "Ændringerne kunne ikke gemmes. Prøv igen om lidt.");
      setStatus(null);
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-5">
      <p className="rounded-xl border border-info-kant bg-info-bg px-4 py-3 text-sm text-info-tekst">
        Du kan ændre auktionen, indtil der kommer det første bud. Varigheden og postnummeret kan ikke ændres.
      </p>

      <Sektion nr={1} titel="Billeder" id="sektion-billeder">
        <BilledVaelger billeder={billeder} setBilleder={setBilleder} fejlId="billeder-fejl" />
      </Sektion>

      <Sektion nr={2} titel="Titel og beskrivelse" id="sektion-titel">
        <div>
          <label htmlFor="titel" className="mb-1.5 block text-sm font-medium text-tekst">
            Titel
          </label>
          <input
            id="titel"
            type="text"
            maxLength={MAKS_TITEL}
            value={titel}
            onChange={(e) => setTitel(e.target.value)}
            aria-invalid={forbudtTekst ? true : undefined}
            aria-describedby={forbudtTekst ? "titel-forbudt" : undefined}
            className={feltKlasse(!!forbudtTekst)}
          />
          {forbudtTekst && (
            <FeltFejl id="titel-forbudt">
              {forbudtTekst}{" "}
              <Link href="/forbudte-varer" target="_blank" className="underline">
                Se forbudte varer
              </Link>
            </FeltFejl>
          )}
        </div>
        <div>
          <label htmlFor="beskrivelse" className="mb-1.5 block text-sm font-medium text-tekst">
            Beskrivelse <span className="font-normal text-tekst-svag">(valgfrit)</span>
          </label>
          <textarea
            id="beskrivelse"
            rows={5}
            maxLength={MAKS_BESKRIVELSE}
            value={beskrivelse}
            onChange={(e) => setBeskrivelse(e.target.value)}
            className={tekstfeltKlasse()}
          />
          <Hjaelp>
            {beskrivelse.length}/{MAKS_BESKRIVELSE}
          </Hjaelp>
        </div>
      </Sektion>

      <Sektion nr={3} titel="Kategori og stand" id="sektion-kategori">
        <div>
          <label htmlFor="kategori" className="mb-1.5 block text-sm font-medium text-tekst">
            Kategori
          </label>
          <select id="kategori" value={kategori} onChange={(e) => setKategori(e.target.value)} className={feltKlasse()}>
            {!kategori && <option value="">Vælg kategori</option>}
            {kategorier.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <StandVaelger vaerdi={stand} onChange={setStand} fejlId="stand-fejl" />
      </Sektion>

      <Sektion nr={4} titel="Pris og levering" id="sektion-pris">
        <div>
          <label htmlFor="startpris" className="mb-1.5 block text-sm font-medium text-tekst">
            Startpris (kr.)
          </label>
          <input
            id="startpris"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={startprisTekst}
            onChange={(e) => setStartprisTekst(e.target.value.replace(/\D/g, "").slice(0, 10))}
            placeholder={`Mindst ${MINDSTE_STARTPRIS} kr.`}
            aria-describedby="startpris-hjaelp"
            className={feltKlasse()}
          />
          <Hjaelp id="startpris-hjaelp">
            {STARTPRIS_ANBEFALING} Startprisen er også den laveste pris, du sælger til.
          </Hjaelp>
        </div>
        <Afkrydsning
          id="forsendelse"
          checked={forsendelseMulig}
          onChange={setForsendelseMulig}
          hjaelp="Varen sendes til køberen, som betaler 35 kr i fragt. Uden forsendelse skal køberen hente varen hos dig."
        >
          Jeg tilbyder forsendelse
        </Afkrydsning>
      </Sektion>

      {error && (
        <div role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          {error}
        </div>
      )}
      {status && (
        <p role="status" className="flex items-center gap-2 text-sm text-tekst-daempet">
          <Spinner /> {status}
        </p>
      )}

      <button type="submit" disabled={loading} aria-busy={loading} className={`${primaerKnap} sm:w-full`}>
        {loading && <Spinner />}
        Gem ændringer
      </button>
    </form>
  );
}
