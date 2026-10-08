"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { kategorier } from "@/lib/kategorier";
import {
  MAKS_BESKRIVELSE,
  MAKS_TITEL,
  MINDSTE_STARTPRIS,
  STANDARD_VARIGHED,
  STARTPRIS_ANBEFALING,
  VARIGHEDER,
  erGyldigVarighed,
  slutterKlFraVarighed,
  valideStartpris,
  type VarighedDage,
} from "@/lib/auktionRegler";
import { forbudtBesked, tjekForbudtTekst } from "@/lib/forbudteVarer";
import { erStand, standNavn } from "@/lib/stand";
import { erhvervFejlTekst } from "@/lib/erhverv/regler";
import GpsrFelter, { gpsrFejl } from "@/components/opret/GpsrFelter";
import { ERHVERV_GPSR } from "@/lib/tekster/erhverv";
import { SPOERGSMAAL_SLAAET_FRA } from "@/lib/spoergsmaal";
import { kroner } from "@/lib/kroner";
import { UKENDT_POSTNUMMER, slaaPostnummerOp } from "@/lib/postnumre";
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
  sekundaerKnap,
  tekstfeltKlasse,
  type Billede,
} from "@/components/opret/formular";

// Opret auktion i sektioner: billeder, titel/beskrivelse, kategori og stand,
// pris og varighed, levering, spørgsmål - og en forhåndsvisning, før den
// oprettes. Felterne (ikke billederne) gemmes som kladde i browseren, indtil
// auktionen er oprettet. Databasen håndhæver alle regler igen.

type Kladde = {
  titel: string;
  beskrivelse: string;
  kategori: string;
  stand: string;
  startpris: string;
  varighed: number;
  forsendelseMulig: boolean;
  postnummer: string;
  spoergsmaalAktiv: boolean;
};

type FeltNavn =
  | "billeder"
  | "titel"
  | "beskrivelse"
  | "kategori"
  | "stand"
  | "producent"
  | "sikkerhedsoplysninger"
  | "startpris"
  | "postnummer"
  | "bekraeft";

const FELT_ID: Record<FeltNavn, string> = {
  billeder: "billeder",
  titel: "titel",
  beskrivelse: "beskrivelse",
  kategori: "kategori",
  stand: "stand",
  producent: "producent",
  sikkerhedsoplysninger: "sikkerhedsoplysninger",
  startpris: "startpris",
  postnummer: "postnummer",
  bekraeft: "bekraeft",
};

const kladdeNoegle = (brugerId: string) => `bidhamr:opret-kladde:${brugerId}`;

function laesKladde(noegle: string): string | null {
  try {
    return window.localStorage.getItem(noegle);
  } catch {
    return null;
  }
}
function gemKladde(noegle: string, k: Kladde) {
  try {
    window.localStorage.setItem(noegle, JSON.stringify({ ...k, gemt: Date.now() }));
  } catch {
    // Privat browsing / fuld lagerplads: kladden gemmes bare ikke.
  }
}
function sletKladde(noegle: string) {
  try {
    window.localStorage.removeItem(noegle);
  } catch {
    // ignoreres
  }
}
function fortolkKladde(raa: string | null): Kladde | null {
  if (!raa) return null;
  try {
    const k = JSON.parse(raa) as Partial<Kladde>;
    if (!k || typeof k !== "object") return null;
    return {
      titel: typeof k.titel === "string" ? k.titel.slice(0, MAKS_TITEL) : "",
      beskrivelse: typeof k.beskrivelse === "string" ? k.beskrivelse.slice(0, MAKS_BESKRIVELSE) : "",
      kategori: typeof k.kategori === "string" && kategorier.includes(k.kategori) ? k.kategori : "",
      stand: erStand(k.stand) ? k.stand : "",
      startpris: typeof k.startpris === "string" ? k.startpris.replace(/\D/g, "").slice(0, 10) : "",
      varighed: erGyldigVarighed(k.varighed) ? k.varighed : STANDARD_VARIGHED,
      forsendelseMulig: k.forsendelseMulig === true,
      postnummer: typeof k.postnummer === "string" ? k.postnummer.replace(/\D/g, "").slice(0, 4) : "",
      spoergsmaalAktiv: k.spoergsmaalAktiv !== false,
    };
  } catch {
    return null;
  }
}

const ingenAbonnement = () => () => {};

// erFirma: firmakonto (users.konto_type = 'erhverv'). Ved stand "Ny med
// mærke" skal producent og sikkerhedsoplysninger udfyldes (GPSR). Private ser
// ikke felterne.
export default function OpretAuktionForm({ brugerId, erFirma = false }: { brugerId: string; erFirma?: boolean }) {
  const router = useRouter();
  const noegle = kladdeNoegle(brugerId);
  const fejlBoksRef = useRef<HTMLDivElement>(null);
  // Idempotens: én nøgle pr. formular. Databasen afviser en anden auktion med
  // samme nøgle (auctions_idempotens_unik), så et dobbeltklik giver kun én.
  const idempotensNoegle = useRef<string | null>(null);
  // Spærrer et nyt klik, mens oprettelsen kører (samme tick som klikket).
  const opretterRef = useRef(false);

  const [billeder, setBilleder] = useState<Billede[]>([]);
  const [titel, setTitel] = useState("");
  const [beskrivelse, setBeskrivelse] = useState("");
  const [kategori, setKategori] = useState("");
  const [stand, setStand] = useState("");
  const [producent, setProducent] = useState("");
  const [sikkerhed, setSikkerhed] = useState("");
  const kraeverGpsr = erFirma && stand === "ny_med_maerke";
  const [startprisTekst, setStartprisTekst] = useState("");
  const [varighed, setVarighed] = useState<VarighedDage>(STANDARD_VARIGHED);
  const [forsendelseMulig, setForsendelseMulig] = useState(false);
  const [postnummer, setPostnummer] = useState("");
  const [spoergsmaalAktiv, setSpoergsmaalAktiv] = useState(true);
  const [bekraeftet, setBekraeftet] = useState(false);

  const [roert, setRoert] = useState(false);
  const [kladdeHaandteret, setKladdeHaandteret] = useState(false);
  const [forsoegt, setForsoegt] = useState(false);
  const [visForhaandsvisning, setVisForhaandsvisning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Kladden læses som et "eksternt lager" - ingen setState i en effekt, og
  // serveren renderer uden kladde (ingen hydreringsfejl).
  const gemtKladdeRaa = useSyncExternalStore(ingenAbonnement, () => laesKladde(noegle), () => null);
  const gemtKladde = fortolkKladde(gemtKladdeRaa);
  const visKladdeBanner = !!gemtKladde && !roert && !kladdeHaandteret;

  const kladde: Kladde = {
    titel,
    beskrivelse,
    kategori,
    stand,
    startpris: startprisTekst,
    varighed,
    forsendelseMulig,
    postnummer,
    spoergsmaalAktiv,
  };
  const kladdeJson = JSON.stringify(kladde);

  // Gem kladden, når brugeren har skrevet noget (ikke ved første visning, så
  // en gemt kladde ikke overskrives, før brugeren har valgt).
  useEffect(() => {
    if (!roert) return;
    const t = window.setTimeout(() => gemKladde(noegle, JSON.parse(kladdeJson) as Kladde), 400);
    return () => window.clearTimeout(t);
  }, [roert, kladdeJson, noegle]);

  function aendret<T>(saet: (v: T) => void) {
    return (v: T) => {
      setRoert(true);
      saet(v);
    };
  }

  function hentKladde() {
    if (!gemtKladde) return;
    setTitel(gemtKladde.titel);
    setBeskrivelse(gemtKladde.beskrivelse);
    setKategori(gemtKladde.kategori);
    setStand(gemtKladde.stand);
    setStartprisTekst(gemtKladde.startpris);
    setVarighed(gemtKladde.varighed as VarighedDage);
    setForsendelseMulig(gemtKladde.forsendelseMulig);
    setPostnummer(gemtKladde.postnummer);
    setSpoergsmaalAktiv(gemtKladde.spoergsmaalAktiv);
    setKladdeHaandteret(true);
    setRoert(true);
  }

  function kasserKladde() {
    sletKladde(noegle);
    setKladdeHaandteret(true);
  }

  // ------------------------------------------------------------ postnummer
  // Slås op i den lokale postnummerliste (synkront, ingen netværkskald).
  const gyldigtPostnummer = /^\d{4}$/.test(postnummer);
  const postOpslag = gyldigtPostnummer ? slaaPostnummerOp(postnummer) : null;
  const by = postOpslag?.by ?? null;
  const koordinater = postOpslag ? { lat: postOpslag.lat, lng: postOpslag.lng } : null;
  const byStatus: "idle" | "fundet" | "ikke-fundet" = !gyldigtPostnummer
    ? "idle"
    : postOpslag
      ? "fundet"
      : "ikke-fundet";

  // ------------------------------------------------------------ validering
  const startpris = startprisTekst === "" ? NaN : Number(startprisTekst);
  const forbudt = tjekForbudtTekst(titel, beskrivelse);
  const forbudtTekst = forbudt.resultat === "blokeret" ? forbudtBesked(forbudt.ord, forbudt.kategori) : null;

  function valider(): Partial<Record<FeltNavn, string>> {
    const f: Partial<Record<FeltNavn, string>> = {};
    if (billeder.length === 0) f.billeder = "Tilføj mindst ét billede af varen.";
    else if (!billeder.every(billedeKlar)) f.billeder = "Vent, til billederne er klar.";
    if (!titel.trim()) f.titel = "Skriv en titel, fx mærke og model.";
    else if (forbudtTekst) f.titel = forbudtTekst;
    if (!kategori) f.kategori = "Vælg en kategori.";
    if (!erStand(stand)) f.stand = "Vælg varens stand.";
    if (kraeverGpsr) {
      const g = gpsrFejl(producent, sikkerhed);
      if (g.producent) f.producent = g.producent;
      if (g.sikkerhed) f.sikkerhedsoplysninger = g.sikkerhed;
    }
    const prisFejl = valideStartpris(startpris);
    if (prisFejl) f.startpris = prisFejl;
    if (!gyldigtPostnummer) f.postnummer = "Skriv et postnummer med 4 cifre.";
    else if (byStatus !== "fundet" || !by) f.postnummer = UKENDT_POSTNUMMER;
    if (!bekraeftet) f.bekraeft = "Bekræft, at varen ikke er forbudt.";
    return f;
  }

  const feltFejl = forsoegt ? valider() : {};
  const antalFejl = Object.keys(feltFejl).length;

  function visForhaand(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setForsoegt(true);
    const f = valider();
    const foerste = (Object.keys(FELT_ID) as FeltNavn[]).find((k) => f[k]);
    if (foerste) {
      // Fokus på fejlboksen øverst, så skærmlæsere hører fejlene.
      window.requestAnimationFrame(() => fejlBoksRef.current?.focus());
      return;
    }
    setVisForhaandsvisning(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function opret() {
    if (opretterRef.current) return;
    setError(null);
    const f = valider();
    if (Object.keys(f).length > 0 || !by) {
      setVisForhaandsvisning(false);
      setForsoegt(true);
      return;
    }

    opretterRef.current = true;
    idempotensNoegle.current ??= crypto.randomUUID();
    const noegleTilOprettelse = idempotensNoegle.current;
    setLoading(true);
    const supabase = createClient();
    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getUser();
      if (sessionError || !sessionData.user) {
        throw new Error("Du er ikke logget ind længere. Log ind igen, og prøv en gang til – din kladde er gemt.");
      }
      const uid = sessionData.user.id;

      const billedeUrls = await uploadAuktionsbilleder(
        supabase,
        uid,
        billeder.map((b) =>
          b.slags === "gemt" ? { url: b.url } : b.status === "klar" ? { fil: b.fil } : { url: "" },
        ),
        (nr, ialt) => setStatus(`Uploader billede ${nr} af ${ialt} …`),
      );
      setStatus("Opretter auktionen …");

      const { data, error: insertError } = await supabase
        .from("auctions")
        .insert({
          bruger_id: uid,
          titel: titel.trim(),
          beskrivelse: beskrivelse.trim() || null,
          billeder: billedeUrls,
          startpris,
          kategori,
          stand,
          // GPSR: kun firmakonti ved "Ny med mærke" (databasen nulstiller dem for private).
          ...(kraeverGpsr ? { producent: producent.trim(), sikkerhedsoplysninger: sikkerhed.trim() } : {}),
          postnummer,
          lokation: by,
          lat: koordinater?.lat ?? null,
          lng: koordinater?.lng ?? null,
          forsendelse_mulig: forsendelseMulig,
          spoergsmaal_aktiv: spoergsmaalAktiv,
          forbudt_bekraeftet: bekraeftet,
          // Databasen beregner selv sluttidspunktet ud fra varigheden.
          varighed_dage: varighed,
          slutter_kl: slutterKlFraVarighed(varighed).toISOString(),
          idempotens_noegle: noegleTilOprettelse,
        })
        .select("id")
        .single();

      // Dublet (fx to klik): auktionen findes allerede - vis den.
      if (insertError?.code === "23505" && insertError.message.includes("auctions_idempotens_unik")) {
        const { data: eksisterende } = await supabase.rpc("min_auktion_for_noegle", {
          p_noegle: noegleTilOprettelse,
        });
        if (typeof eksisterende === "string") {
          sletKladde(noegle);
          router.push(`/auktion/${eksisterende}`);
          return;
        }
      }

      if (insertError) {
        console.error("Fejl ved oprettelse af auktion:", insertError.code, insertError.message);
        let besked = "Auktionen kunne ikke oprettes. Prøv igen om lidt – din kladde er gemt.";
        if (insertError.code === "BHU01") besked = "Du skal oprette en udbetalingskonto, før du kan sætte varer til salg.";
        else if (insertError.code === "22023") besked = "Tjek startpris og varighed (3, 5, 7 eller 10 dage), og prøv igen.";
        else if (insertError.code === "BHA01") besked = "Et af billederne kunne ikke bruges. Fjern det, tilføj det igen, og prøv igen.";
        else if (insertError.code === "BHA02") besked = "Vælg en kategori.";
        else if (insertError.code === "BHA03") besked = "Vælg varens stand.";
        else if (insertError.code === "BHA04") besked = `Titlen må højst være ${MAKS_TITEL} tegn.`;
        else if (insertError.code === "BHA05") besked = `Beskrivelsen må højst være ${MAKS_BESKRIVELSE} tegn.`;
        else if (erhvervFejlTekst(insertError.message, insertError.code))
          besked = erhvervFejlTekst(insertError.message, insertError.code)!;
        else if (insertError.code === "BHS02")
          besked = "Din konto er suspenderet, og du kan ikke sætte varer til salg. Kontakt support@bidhamr.dk, hvis du mener, det er en fejl.";
        else if (insertError.code === "BHF01") {
          let ord = "";
          let kat = "";
          try {
            const d = JSON.parse(insertError.details ?? "{}") as { ord?: string; kategori?: string };
            ord = d.ord ?? "";
            kat = d.kategori ?? "";
          } catch {
            // brug standardteksten
          }
          besked = ord ? forbudtBesked(ord, kat) : "Auktionen ligner en forbudt vare og kan ikke oprettes.";
        }
        setError(besked);
        setStatus(null);
        setLoading(false);
        opretterRef.current = false;
        return;
      }

      sletKladde(noegle);
      router.push(`/auktion/${data.id}`);
    } catch (err) {
      console.error("Fejl ved oprettelse af auktion:", err);
      setError(err instanceof Error ? err.message : "Auktionen kunne ikke oprettes. Prøv igen om lidt.");
      setStatus(null);
      setLoading(false);
      opretterRef.current = false;
    }
  }

  const describedBy = (felt: FeltNavn, hjaelp?: string) =>
    [hjaelp, feltFejl[felt] ? `${FELT_ID[felt]}-fejl` : ""].filter(Boolean).join(" ") || undefined;

  // ------------------------------------------------------------ forhåndsvisning
  if (visForhaandsvisning) {
    const forside = billeder[0];
    const forsideUrl = forside ? (forside.slags === "gemt" ? forside.url : forside.status === "klar" ? forside.preview : "") : "";
    return (
      <div className="space-y-5">
        <div className="rounded-xl border border-info-kant bg-info-bg px-4 py-3 text-sm text-info-tekst">
          Sådan ser din auktion ud. Tjek, at alt er rigtigt – når der er budt, kan den ikke ændres.
        </div>

        <article className="overflow-hidden rounded-[14px] border border-kant bg-white">
          {forsideUrl && (
            <div className="aspect-[4/3] bg-skelet">
              {/* eslint-disable-next-line @next/next/no-img-element -- lokal blob-URL */}
              <img src={forsideUrl} alt="Forsidebillede" className="h-full w-full object-cover" />
            </div>
          )}
          {billeder.length > 1 && (
            <ul className="flex gap-2 overflow-x-auto px-4 pt-3">
              {billeder.slice(1).map((b, i) => (
                <li key={b.noegle} className="h-14 w-14 shrink-0 overflow-hidden rounded-md bg-skelet">
                  {/* eslint-disable-next-line @next/next/no-img-element -- lokal blob-URL */}
                  <img
                    src={b.slags === "gemt" ? b.url : b.status === "klar" ? b.preview : ""}
                    alt={`Billede ${i + 2}`}
                    className="h-full w-full object-cover"
                  />
                </li>
              ))}
            </ul>
          )}
          <div className="space-y-4 p-4 sm:p-6">
            <div>
              <h2 className="break-words font-serif text-xl font-semibold text-tekst">{titel.trim()}</h2>
              <div className="mt-2 flex flex-wrap gap-2">
                <span className="rounded-full bg-groen-lys px-3 py-1.5 text-[13px] font-medium text-groen-mork">
                  {standNavn(stand)}
                </span>
                <span className="rounded-full bg-groen-lys px-3 py-1.5 text-[13px] font-medium text-groen-mork">
                  {kategori}
                </span>
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-tekst-svag">Startpris</dt>
                <dd className="text-lg font-bold text-tekst">{kroner(Math.round(startpris * 100))}</dd>
              </div>
              <div>
                <dt className="text-tekst-svag">Varighed</dt>
                <dd className="text-tekst">{varighed} dage</dd>
              </div>
              <div>
                <dt className="text-tekst-svag">Levering</dt>
                <dd className="text-tekst">{forsendelseMulig ? "Afhentning eller forsendelse" : "Kun afhentning"}</dd>
              </div>
              <div>
                <dt className="text-tekst-svag">Lokation</dt>
                <dd className="text-tekst">
                  {by} ({postnummer})
                </dd>
              </div>
            </dl>
            {kraeverGpsr && (
              <dl className="space-y-2 text-sm">
                <div>
                  <dt className="text-tekst-svag">{ERHVERV_GPSR.producentLabel}</dt>
                  <dd className="whitespace-pre-line break-words text-tekst">{producent.trim()}</dd>
                </div>
                <div>
                  <dt className="text-tekst-svag">{ERHVERV_GPSR.sikkerhedLabel}</dt>
                  <dd className="whitespace-pre-line break-words text-tekst">{sikkerhed.trim()}</dd>
                </div>
              </dl>
            )}
            {beskrivelse.trim() && (
              <div>
                <h3 className="text-sm font-semibold text-tekst">Beskrivelse</h3>
                <p className="mt-1 whitespace-pre-line break-words text-[15px] text-tekst-daempet">{beskrivelse.trim()}</p>
              </div>
            )}
            <p className="text-[13px] text-tekst-daempet">
              {spoergsmaalAktiv ? "Købere kan stille dig spørgsmål, mens auktionen kører." : SPOERGSMAAL_SLAAET_FRA}
            </p>
          </div>
        </article>

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

        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={() => setVisForhaandsvisning(false)}
            disabled={loading}
            className={sekundaerKnap}
          >
            Ret auktionen
          </button>
          <button type="button" onClick={opret} disabled={loading} aria-busy={loading} className={primaerKnap}>
            {loading && <Spinner />}
            Opret auktion
          </button>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------ formular
  return (
    <form onSubmit={visForhaand} noValidate className="space-y-5">
      {visKladdeBanner && (
        <div className="rounded-xl border border-info-kant bg-info-bg p-4 text-sm text-info-tekst">
          <p className="font-semibold">Du har en kladde, der ikke er oprettet.</p>
          <p className="mt-0.5">Vil du fortsætte, hvor du slap? Billeder gemmes ikke i kladden.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={hentKladde} className={sekundaerKnap}>
              Fortsæt kladden
            </button>
            <button
              type="button"
              onClick={kasserKladde}
              className="inline-flex min-h-11 items-center px-3 text-sm font-medium text-groen hover:underline"
            >
              Start forfra
            </button>
          </div>
        </div>
      )}

      {forsoegt && antalFejl > 0 && (
        <div
          ref={fejlBoksRef}
          tabIndex={-1}
          role="alert"
          className="rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst focus:outline-2 focus:outline-fejl-tekst"
        >
          <p className="font-semibold">
            {antalFejl === 1 ? "Der mangler én ting" : `Der mangler ${antalFejl} ting`}, før du kan se auktionen:
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {(Object.keys(FELT_ID) as FeltNavn[])
              .filter((k) => feltFejl[k])
              .map((k) => (
                <li key={k}>
                  <a href={`#${FELT_ID[k]}`} className="underline">
                    {feltFejl[k]}
                  </a>
                </li>
              ))}
          </ul>
        </div>
      )}

      <Sektion nr={1} titel="Billeder" id="sektion-billeder">
        <div id={FELT_ID.billeder} tabIndex={-1}>
          <p className="mb-2 text-[13px] text-tekst-daempet">
            Gode billeder sælger. Vis varen forfra, bagfra og eventuelle fejl. Det første billede er forsidebilledet.
          </p>
          <BilledVaelger
            billeder={billeder}
            setBilleder={(fn) => {
              setRoert(true);
              setBilleder(fn);
            }}
            fejl={feltFejl.billeder}
            fejlId={`${FELT_ID.billeder}-fejl`}
          />
        </div>
      </Sektion>

      <Sektion nr={2} titel="Titel og beskrivelse" id="sektion-titel">
        <div>
          <label htmlFor={FELT_ID.titel} className="mb-1.5 block text-sm font-medium text-tekst">
            Titel
          </label>
          <input
            id={FELT_ID.titel}
            type="text"
            maxLength={MAKS_TITEL}
            value={titel}
            onChange={(e) => aendret(setTitel)(e.target.value)}
            placeholder="Fx: iPhone 13, 128 GB, sort"
            aria-invalid={feltFejl.titel || forbudtTekst ? true : undefined}
            aria-describedby={describedBy("titel", "titel-hjaelp")}
            className={feltKlasse(!!feltFejl.titel || !!forbudtTekst)}
          />
          <Hjaelp id="titel-hjaelp">
            Skriv mærke, model og størrelse. {titel.length}/{MAKS_TITEL}
          </Hjaelp>
          {feltFejl.titel ? (
            <FeltFejl id="titel-fejl">{feltFejl.titel}</FeltFejl>
          ) : (
            forbudtTekst && (
              <FeltFejl id="titel-forbudt">
                {forbudtTekst}{" "}
                <Link href="/forbudte-varer" target="_blank" className="underline">
                  Se forbudte varer
                </Link>
              </FeltFejl>
            )
          )}
        </div>

        <div>
          <label htmlFor={FELT_ID.beskrivelse} className="mb-1.5 block text-sm font-medium text-tekst">
            Beskrivelse <span className="font-normal text-tekst-svag">(valgfrit)</span>
          </label>
          <textarea
            id={FELT_ID.beskrivelse}
            rows={5}
            maxLength={MAKS_BESKRIVELSE}
            value={beskrivelse}
            onChange={(e) => aendret(setBeskrivelse)(e.target.value)}
            placeholder="Fortæl om alder, mål, fejl og mangler – og hvad der følger med."
            aria-describedby="beskrivelse-hjaelp"
            className={tekstfeltKlasse()}
          />
          <Hjaelp id="beskrivelse-hjaelp">
            En ærlig beskrivelse giver færre spørgsmål og sager. {beskrivelse.length}/{MAKS_BESKRIVELSE}
          </Hjaelp>
        </div>
      </Sektion>

      <Sektion nr={3} titel="Kategori og stand" id="sektion-kategori">
        <div>
          <label htmlFor={FELT_ID.kategori} className="mb-1.5 block text-sm font-medium text-tekst">
            Kategori
          </label>
          <select
            id={FELT_ID.kategori}
            value={kategori}
            onChange={(e) => aendret(setKategori)(e.target.value)}
            aria-invalid={feltFejl.kategori ? true : undefined}
            aria-describedby={describedBy("kategori")}
            className={feltKlasse(!!feltFejl.kategori)}
          >
            <option value="">Vælg kategori</option>
            {kategorier.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          {feltFejl.kategori && <FeltFejl id="kategori-fejl">{feltFejl.kategori}</FeltFejl>}
        </div>
        <div id={FELT_ID.stand} tabIndex={-1}>
          <StandVaelger vaerdi={stand} onChange={aendret(setStand)} fejl={feltFejl.stand} fejlId="stand-fejl" />
        </div>
        {kraeverGpsr && (
          <GpsrFelter
            producent={producent}
            sikkerhed={sikkerhed}
            onProducent={aendret(setProducent)}
            onSikkerhed={aendret(setSikkerhed)}
            fejl={
              feltFejl.producent || feltFejl.sikkerhedsoplysninger
                ? { producent: feltFejl.producent ?? null, sikkerhed: feltFejl.sikkerhedsoplysninger ?? null }
                : null
            }
          />
        )}
      </Sektion>

      <Sektion nr={4} titel="Pris og varighed" id="sektion-pris">
        <div>
          <label htmlFor={FELT_ID.startpris} className="mb-1.5 block text-sm font-medium text-tekst">
            Startpris (kr.)
          </label>
          <input
            id={FELT_ID.startpris}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={startprisTekst}
            onChange={(e) => aendret(setStartprisTekst)(e.target.value.replace(/\D/g, "").slice(0, 10))}
            placeholder={`Mindst ${MINDSTE_STARTPRIS} kr.`}
            aria-invalid={feltFejl.startpris ? true : undefined}
            aria-describedby={describedBy("startpris", "startpris-hjaelp")}
            className={feltKlasse(!!feltFejl.startpris)}
          />
          <Hjaelp id="startpris-hjaelp">
            {STARTPRIS_ANBEFALING} Startprisen er også den laveste pris, du sælger til.
          </Hjaelp>
          {feltFejl.startpris && <FeltFejl id="startpris-fejl">{feltFejl.startpris}</FeltFejl>}
        </div>

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-tekst">Varighed</legend>
          <div className="flex flex-wrap gap-2">
            {VARIGHEDER.map((v) => (
              <label
                key={v.dage}
                className={`inline-flex min-h-11 cursor-pointer items-center rounded-full border px-4 text-sm font-medium transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-groen ${
                  varighed === v.dage ? "border-groen bg-groen text-white" : "border-kant-staerk text-tekst hover:bg-groen-lys"
                }`}
              >
                <input
                  type="radio"
                  name="varighed"
                  value={v.dage}
                  checked={varighed === v.dage}
                  onChange={() => aendret(setVarighed)(v.dage)}
                  className="sr-only"
                />
                {v.label}
              </label>
            ))}
          </div>
          <Hjaelp>Varigheden kan ikke ændres, når auktionen er oprettet.</Hjaelp>
        </fieldset>
      </Sektion>

      <Sektion nr={5} titel="Levering" id="sektion-levering">
        <div>
          <label htmlFor={FELT_ID.postnummer} className="mb-1.5 block text-sm font-medium text-tekst">
            Postnummer, hvor varen kan hentes
          </label>
          <input
            id={FELT_ID.postnummer}
            type="text"
            inputMode="numeric"
            autoComplete="postal-code"
            maxLength={4}
            value={postnummer}
            onChange={(e) => aendret(setPostnummer)(e.target.value.replace(/\D/g, "").slice(0, 4))}
            placeholder="Fx 8000"
            aria-invalid={feltFejl.postnummer ? true : undefined}
            aria-describedby={describedBy("postnummer", "postnummer-status")}
            className={`${feltKlasse(!!feltFejl.postnummer)} sm:max-w-[200px]`}
          />
          <p id="postnummer-status" className="mt-1.5 text-[13px] text-tekst-daempet" aria-live="polite">
            {byStatus === "ikke-fundet" && !feltFejl.postnummer && (
              <span className="font-medium text-fejl-tekst">{UKENDT_POSTNUMMER}</span>
            )}
            {byStatus === "fundet" && by && <span className="font-medium text-tekst">{by}</span>}
            {byStatus === "idle" && "Kun byen vises på auktionen – aldrig din adresse."}
          </p>
          {feltFejl.postnummer && <FeltFejl id="postnummer-fejl">{feltFejl.postnummer}</FeltFejl>}
        </div>

        <Afkrydsning
          id="forsendelse"
          checked={forsendelseMulig}
          onChange={aendret(setForsendelseMulig)}
          hjaelp="Varen sendes til køberen, som betaler omkring 35 kr. i fragt. Uden forsendelse skal køberen hente varen hos dig."
        >
          Jeg tilbyder forsendelse
        </Afkrydsning>
      </Sektion>

      <Sektion nr={6} titel="Spørgsmål fra købere" id="sektion-spoergsmaal">
        <Afkrydsning
          id="spoergsmaal-aktiv"
          checked={spoergsmaalAktiv}
          onChange={aendret(setSpoergsmaalAktiv)}
          hjaelp={
            spoergsmaalAktiv
              ? "Købere kan stille dig spørgsmål på auktionssiden. Spørgsmål og svar kan ses af alle. Du kan slå det fra undervejs."
              : `Køberne ser: "${SPOERGSMAAL_SLAAET_FRA}" Du kan slå det til undervejs.`
          }
        >
          Købere må stille mig spørgsmål
        </Afkrydsning>
      </Sektion>

      <div className="rounded-[14px] border border-kant bg-white p-4 sm:p-6">
        <Afkrydsning
          id={FELT_ID.bekraeft}
          checked={bekraeftet}
          onChange={setBekraeftet}
          fejl={feltFejl.bekraeft}
          hjaelp={
            <>
              Fx våben, narkotika, medicin, levende dyr og kopivarer.{" "}
              <Link href="/forbudte-varer" target="_blank" className="font-medium text-groen underline">
                Se hele listen
              </Link>
            </>
          }
        >
          Jeg bekræfter, at varen ikke er forbudt
        </Afkrydsning>
      </div>

      {error && (
        <div role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          {error}
        </div>
      )}

      <div className="sticky bottom-[var(--samtykke-hoejde,0px)] -mx-4 border-t border-kant bg-white p-4 sm:static sm:mx-0 sm:border-0 sm:p-0">
        <button type="submit" className={`${primaerKnap} sm:w-full`}>
          Se forhåndsvisning
        </button>
        <p className="mt-2 text-center text-[13px] text-tekst-svag">
          Du ser auktionen, før den bliver oprettet. {roert ? "Din kladde gemmes automatisk." : ""}
        </p>
      </div>
    </form>
  );
}
