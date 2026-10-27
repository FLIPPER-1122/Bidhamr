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
  NETVAERKSFEJL,
  STARTPRIS_ANBEFALING,
  erAuktionLaastBesked,
  valideStartpris,
} from "@/lib/auktionRegler";
import { AuktionLaastTekst } from "@/components/SaelgerAuktionHandlinger";
import { forbudtBesked, tjekForbudtTekst } from "@/lib/forbudteVarer";
import { KUNST_TEKST, tjekKunstTekst } from "@/lib/kunstForbud";
import KunstAdvarsel from "@/components/opret/KunstAdvarsel";
import { auktionKontaktGrund, auktionKontaktTekst, type AuktionKontaktFelt } from "@/lib/auktionKontaktinfo";
import { erStand } from "@/lib/stand";
import PakkestoerrelseVaelger, {
  fragtFejlTekst,
  useFragtstoerrelser,
  vaegtFejl,
  vaegtTilGram,
  type Fragtstoerrelse,
} from "@/components/fragt/PakkestoerrelseVaelger";
import { uploadAuktionsbilleder } from "@/lib/auktionUpload";
import GpsrFelter, { gpsrFejl } from "@/components/opret/GpsrFelter";
import { ERHVERV_MOMS } from "@/lib/tekster/erhverv";
import {
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
import { useHydreret } from "@/lib/useHydreret";

// Samme felter og byggesten som OpretAuktionForm. Postnummer og varighed kan
// ikke ændres. Nye billeder klargøres (HEIC -> JPEG, maks 2000 px) og uploades
// i browseren til sælgerens egen mappe; selve ændringen gemmes på serveren
// (redigerAuktion -> rediger_auktion), som afviser den, hvis der er kommet et
// bud imens.

export default function RedigerAuktionForm({
  auktionId,
  brugerId,
  start,
  erFirma = false,
}: {
  auktionId: string;
  brugerId: string;
  // Firmakonto: GPSR-felter ved "Ny med mærke" (private ser dem ikke).
  erFirma?: boolean;
  start: {
    titel: string;
    beskrivelse: string;
    billeder: string[];
    kategori: string;
    startpris: number;
    forsendelseMulig: boolean;
    // Sælgeren tilbyder også afhentning (auctions.afhentning_mulig).
    afhentningMulig?: boolean;
    // Den låste fragtpris (øre) og pakkestørrelse - se 20261012010000.
    fragtPakkeshopOere?: number | null;
    fragtDoerOere?: number | null;
    pakkestoerrelse?: string | null;
    vaegtGram?: number | null;
    stand: string | null;
    producent?: string | null;
    sikkerhedsoplysninger?: string | null;
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
  const [afhentningOgsaa, setAfhentningOgsaa] = useState(Boolean(start.afhentningMulig));
  // Pakkestørrelse og vægt: gemmes med saet_auktion_fragt (kun før første bud).
  const startStoerrelse: Fragtstoerrelse["kode"] =
    start.pakkestoerrelse === "lille" || start.pakkestoerrelse === "stor" ? start.pakkestoerrelse : "mellem";
  const startVaegt = start.vaegtGram ? String(start.vaegtGram / 1000).replace(".", ",") : "";
  const [pakkestoerrelse, setPakkestoerrelse] = useState<Fragtstoerrelse["kode"]>(startStoerrelse);
  const [vaegtTekst, setVaegtTekst] = useState(startVaegt);
  const [vaegtFejlTekst, setVaegtFejlTekst] = useState<string | null>(null);
  const { stoerrelser, fejl: fragtHentFejl } = useFragtstoerrelser();
  const [stand, setStand] = useState<string>(erStand(start.stand) ? start.stand : "");
  const [producent, setProducent] = useState(start.producent ?? "");
  const [sikkerhed, setSikkerhed] = useState(start.sikkerhedsoplysninger ?? "");
  const [visGpsrFejl, setVisGpsrFejl] = useState(false);
  const kraeverGpsr = erFirma && stand === "ny_med_maerke";
  const gpsr = kraeverGpsr ? gpsrFejl(producent, sikkerhed) : null;
  const [loading, setLoading] = useState(false);
  // Knappen er slået fra, til siden er hydreret (src/lib/useHydreret.ts).
  const hydreret = useHydreret();
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Gammel fane: der er budt, siden siden blev åbnet. Serveren afviser, og
  // låst-beskeden (med link) vises i stedet for formularen.
  const [laast, setLaast] = useState(false);

  const startpris = startprisTekst === "" ? NaN : Number(startprisTekst);
  // Som databasen (rediger_auktion): forbudte ord tjekkes kun, når teksten
  // er ændret.
  const tekstAendret = titel.trim() !== start.titel.trim() || beskrivelse.trim() !== start.beskrivelse.trim();
  const forbudt = tekstAendret ? tjekForbudtTekst(titel, beskrivelse) : null;
  const forbudtTekst = forbudt?.resultat === "blokeret" ? forbudtBesked(forbudt.ord, forbudt.kategori) : null;
  // Kunst: kun når teksten er ændret (som databasen, auctions_kunst_rapport).
  // Sælgeren bekræfter "Det er ikke kunst"; databasen sender auktionen til
  // staff-tjek uanset hvad.
  const kunst = tekstAendret && !forbudtTekst ? tjekKunstTekst(titel, beskrivelse) : null;
  const kunstOrd = kunst?.resultat === "kunst" ? kunst.ord : null;
  // Kontaktoplysninger (BHA08, src/lib/auktionKontaktinfo.ts): som databasen
  // kun i det felt, der er ændret - en gammel auktion kan stadig få rettet
  // pris og billeder. Firmaer må skrive links. Vises, mens brugeren skriver.
  // serverKontakt: databasen afviste teksten (vises, til den ændres).
  const [serverKontakt, setServerKontakt] = useState<{ felt: AuktionKontaktFelt; tekst: string; vaerdi: string } | null>(
    null,
  );
  const kontaktFejl = (felt: AuktionKontaktFelt, vaerdi: string, foer: string) =>
    vaerdi.trim() === foer.trim()
      ? null
      : auktionKontaktGrund(vaerdi, erFirma) !== null
        ? auktionKontaktTekst(felt, erFirma)
        : serverKontakt?.felt === felt && serverKontakt.vaerdi === vaerdi.trim()
          ? serverKontakt.tekst
          : null;
  const kontaktTitel = forbudtTekst ? null : kontaktFejl("titel", titel, start.titel);
  const kontaktBeskrivelse = kontaktFejl("beskrivelse", beskrivelse, start.beskrivelse);
  const [kunstBekraeftet, setKunstBekraeftet] = useState(false);
  const [visKunstFejl, setVisKunstFejl] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (billeder.length === 0) return setError("Tilføj mindst ét billede.");
    if (!billeder.every(billedeKlar)) return setError("Vent, til billederne er klar.");
    if (!titel.trim()) return setError("Skriv en titel.");
    if (forbudtTekst) return setError(forbudtTekst);
    if (kontaktTitel || kontaktBeskrivelse) {
      document.getElementById(kontaktTitel ? "titel" : "beskrivelse")?.focus();
      return setError((kontaktTitel ?? kontaktBeskrivelse)!);
    }
    if (kunstOrd && !kunstBekraeftet) {
      setVisKunstFejl(true);
      document.getElementById("kunst-bekraeft")?.focus();
      return setError(KUNST_TEKST.mangler);
    }
    if (!kategori) return setError("Vælg en kategori.");
    // Gamle auktioner uden stand må gemmes uden (databasen kræver den kun ved oprettelse).
    if (start.stand && !erStand(stand)) return setError("Vælg varens stand.");
    if (gpsr && (gpsr.producent || gpsr.sikkerhed)) {
      setVisGpsrFejl(true);
      document.getElementById(gpsr.producent ? "producent" : "sikkerhedsoplysninger")?.focus();
      return;
    }
    // En gammel auktion med startpris 0 må beholde den uændret (databasen
    // tjekker kun mindst 1 kr, når startprisen ændres).
    const prisFejl = startpris === start.startpris && startpris === 0 ? null : valideStartpris(startpris);
    if (prisFejl) return setError(prisFejl);
    // Størrelse/vægt sættes kun, når noget er ændret (eller forsendelse slås til).
    const fragtAendret =
      forsendelseMulig &&
      (!start.forsendelseMulig ||
        !start.pakkestoerrelse ||
        pakkestoerrelse !== startStoerrelse ||
        vaegtTekst.trim() !== startVaegt);
    if (fragtAendret) {
      const vf = vaegtFejl(vaegtTekst, stoerrelser?.find((s) => s.kode === pakkestoerrelse) ?? null, stoerrelser ?? []);
      setVaegtFejlTekst(vf);
      if (vf) {
        document.getElementById("vaegt")?.focus();
        return;
      }
    }

    setLoading(true);
    const supabase = createClient();
    let gemmer = false;

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
      gemmer = true;

      const svar = await redigerAuktion(auktionId, {
        titel,
        beskrivelse: beskrivelse || null,
        billeder: urls,
        kategori,
        startpris,
        forsendelseMulig,
        afhentningMulig: forsendelseMulig && afhentningOgsaa,
        stand: erStand(stand) ? stand : null,
        // Kun firmakonti sender felterne (null = uændret).
        producent: erFirma ? producent : null,
        sikkerhedsoplysninger: erFirma ? sikkerhed : null,
      });

      if ("fejl" in svar) {
        if (erAuktionLaastBesked(svar.fejl)) {
          setLaast(true);
          router.refresh();
          return;
        }
        // Kontaktoplysninger (BHA08): fejlen vises også ved feltet.
        if ("felt" in svar && svar.felt) {
          const felt = svar.felt;
          setServerKontakt({ felt, tekst: svar.fejl, vaerdi: (felt === "titel" ? titel : beskrivelse).trim() });
          document.getElementById(felt)?.focus();
        }
        setError(svar.fejl);
        setStatus(null);
        setLoading(false);
        return;
      }

      // Pakkestørrelse og vægt (databasen genberegner og låser fragtprisen).
      if (fragtAendret) {
        const { data: fragtSvar, error: fragtFejl } = await supabase.rpc("saet_auktion_fragt", {
          p_auktion: auktionId,
          p_pakkestoerrelse: pakkestoerrelse,
          p_vaegt_gram: vaegtTilGram(vaegtTekst),
        });
        const kode = (fragtSvar as { kode?: string } | null)?.kode;
        if (fragtFejl || kode !== "ok") {
          if (kode === "har_bud") {
            setLaast(true);
            router.refresh();
            return;
          }
          const tekst =
            kode === "for_tung"
              ? fragtFejlTekst("BHT01")
              : kode === "stoerrelse"
                ? fragtFejlTekst("BHT02")
                : kode === "vaegt_mangler"
                  ? fragtFejlTekst("BHT03")
                  : "Dine andre ændringer er gemt, men pakkestørrelsen blev ikke gemt. Prøv igen.";
          if (kode === "for_tung" || kode === "stoerrelse" || kode === "vaegt_mangler") setVaegtFejlTekst(tekst);
          setError(tekst);
          setStatus(null);
          setLoading(false);
          return;
        }
      }

      // Firmaet redigerer i firma-dashboardet og bliver dér.
      router.push(erFirma ? "/firma/auktioner?gemt=1" : `/auktion/${auktionId}`);
      router.refresh();
    } catch (err) {
      console.error("Fejl ved redigering af auktion:", err);
      // Fejl under upload har en dansk besked; kaster selve gem-kaldet (fx
      // afbrudt forbindelse), er beskeden fra browseren på engelsk.
      setError(gemmer || !(err instanceof Error) ? NETVAERKSFEJL : err.message);
      setStatus(null);
      setLoading(false);
    }
  }

  if (laast) {
    return (
      <p role="alert" className="rounded-lg border border-kant bg-groen-lys px-4 py-3 text-sm text-tekst-daempet">
        <AuktionLaastTekst />
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} method="post" noValidate className="space-y-5">
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
            aria-invalid={forbudtTekst || kontaktTitel ? true : undefined}
            aria-describedby={forbudtTekst ? "titel-forbudt" : kontaktTitel ? "titel-kontakt" : undefined}
            className={feltKlasse(!!forbudtTekst || !!kontaktTitel)}
          />
          {kontaktTitel && <FeltFejl id="titel-kontakt">{kontaktTitel}</FeltFejl>}
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
            aria-invalid={kontaktBeskrivelse ? true : undefined}
            aria-describedby={kontaktBeskrivelse ? "beskrivelse-kontakt" : undefined}
            className={tekstfeltKlasse(!!kontaktBeskrivelse)}
          />
          <Hjaelp>
            {beskrivelse.length}/{MAKS_BESKRIVELSE}
          </Hjaelp>
          {kontaktBeskrivelse && <FeltFejl id="beskrivelse-kontakt">{kontaktBeskrivelse}</FeltFejl>}
        </div>
        <div aria-live="polite">
          {kunstOrd && (
            <KunstAdvarsel
              id="kunst-bekraeft"
              ord={kunstOrd}
              bekraeftet={kunstBekraeftet}
              onBekraeft={setKunstBekraeftet}
              fejl={visKunstFejl && !kunstBekraeftet ? KUNST_TEKST.mangler : null}
            />
          )}
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
        {kraeverGpsr && (
          <GpsrFelter
            producent={producent}
            sikkerhed={sikkerhed}
            onProducent={setProducent}
            onSikkerhed={setSikkerhed}
            fejl={visGpsrFejl ? gpsr : null}
          />
        )}
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
            {erFirma && (
              <span className="mb-1 block text-base font-semibold text-tekst">{ERHVERV_MOMS.startprisHjaelp}.</span>
            )}
            {STARTPRIS_ANBEFALING} Startprisen er også den laveste pris, du sælger til.
          </Hjaelp>
        </div>
        <PakkestoerrelseVaelger
          stoerrelser={stoerrelser}
          hentFejl={fragtHentFejl}
          vaerdi={forsendelseMulig ? pakkestoerrelse : "afhentning"}
          onVaerdi={(v) => {
            if (v === "afhentning") setForsendelseMulig(false);
            else {
              setForsendelseMulig(true);
              setPakkestoerrelse(v);
            }
          }}
          vaegt={vaegtTekst}
          onVaegt={(v) => {
            setVaegtTekst(v);
            if (vaegtFejlTekst) setVaegtFejlTekst(null);
          }}
          vaegtFejlTekst={vaegtFejlTekst}
          vaegtId="vaegt"
          deaktiveret={loading}
          afhentningOgsaa={afhentningOgsaa}
          onAfhentningOgsaa={setAfhentningOgsaa}
        />
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

      <button type="submit" disabled={loading || !hydreret} aria-busy={loading} className={`${primaerKnap} sm:w-full`}>
        {loading && <Spinner />}
        Gem ændringer
      </button>
    </form>
  );
}
