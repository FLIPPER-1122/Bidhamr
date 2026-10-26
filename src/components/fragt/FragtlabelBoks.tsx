"use client";

// "Send pakke" for sælgeren på handelssiden (kun når FRAGT_LABELS_AKTIV=true -
// tjekkes på serveren i siden og i actions):
//   1. Afsenderadresse (forudfyldt med den sidst brugte) -> "Lav fragtlabel".
//   2. Labelfri: DAO's kode eller PostNords QR-kode stort og tydeligt +
//      "Hent label (PDF)". GLS via Shipmondo har ingen labelfri udgående -
//      dér er PDF'en den primære knap.
//   3. Sporingstidslinje og "Annullér label".
// DAO (Filip, 20. okt. 2026): første gang (og ved en ny version af
// betingelserne) skal sælgeren sætte flueben ved DAO's handelsbetingelser,
// før labelen kan laves. Ingen advarselsboks - kun afkrydsningen og linket.
// Serveren håndhæver det (kode "dao_betingelser").
// Pakkestørrelsen er altid auktionens. Fejl fra serveren er danske og vises
// direkte (fx højst 2 labels pr. handel).
import Image from "next/image";
import Link from "next/link";
import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import BekraeftDialog from "@/components/BekraeftDialog";
import Ikon from "@/components/Ikon";
import SporingTidslinje from "@/components/fragt/SporingTidslinje";
import { annullerFragtlabel, hentFragtlabelLink, lavFragtlabel } from "@/app/actions/fragt";
import type { ForsendelseVisning } from "@/lib/fragt/handlinger";
import { TRANSPORTOER_INFO, erTransportoer } from "@/lib/fragt/types";
import { DAO_BETINGELSER, DAO_BETINGELSER_ACCEPT_TEKST, DAO_BETINGELSER_FEJL, DAO_BETINGELSER_KODE } from "@/lib/fragt/betingelser";
import { slaaPostnummerOp } from "@/lib/postnumre";
import { useHydreret } from "@/lib/useHydreret";

export type Afsender = { navn: string; adresse: string; postnummer: string; by: string; telefon: string };

const feltKlasse = (fejl: boolean) =>
  `h-11 w-full rounded-xl border bg-white px-4 text-[15px] text-tekst placeholder:text-pladsholder focus:border-groen focus:outline-2 focus:outline-groen/25 disabled:cursor-not-allowed disabled:bg-[#F7F7F7] ${
    fejl ? "border-fejl-kant bg-fejl-bg/40" : "border-kant-staerk hover:border-[#BFBFBF]"
  }`;

type FeltFejl = Partial<Record<keyof Afsender, string>>;

// Egen dansk validering (formularen har noValidate - ingen browser-bobler).
// Serveren validerer igen (valideerAdresse).
function validerAfsender(a: Afsender): FeltFejl {
  const f: FeltFejl = {};
  if (a.navn.trim().length < 2) f.navn = "Skriv dit fulde navn.";
  if (a.adresse.trim().length < 3) f.adresse = "Skriv vejnavn og husnummer.";
  if (!slaaPostnummerOp(a.postnummer)) f.postnummer = "Skriv et gyldigt dansk postnummer (4 cifre).";
  if (!a.by.trim()) f.by = "Skriv byen.";
  const tlf = a.telefon.replace(/[\s().-]/g, "");
  if (tlf && !/^(\d{8}|(\+|00)\d{8,14})$/.test(tlf)) {
    f.telefon = "Skriv et gyldigt telefonnummer (8 cifre), eller lad feltet være tomt.";
  }
  return f;
}

export default function FragtlabelBoks({
  tradeId,
  forsendelse,
  afsender,
  pakke,
  levering,
  brugteLabels,
  labelGraense = 2,
  transportoer = null,
  kraeverDaoAccept = false,
}: {
  tradeId: string;
  // Den aktive udgående forsendelse (ikke annulleret), eller null.
  forsendelse: ForsendelseVisning | null;
  // Forudfyldning (sidst brugte afsenderadresse / profilens navn).
  afsender: Afsender;
  // Fx "Mellem (op til 5 kg)" - auktionens pakkestørrelse.
  pakke: string | null;
  // Køberens valg, fx "Pakkeshop: Netto, Vesterbrogade 10, 1620 København V".
  levering: string | null;
  // Udgående labels lavet på handlen (også annullerede).
  brugteLabels: number;
  // Højst så mange labels (også annullerede). null = ingen fast grænse: DAO
  // annullerer labelen hos sig selv, så sælgeren kan lave en ny, så længe
  // pakken ikke er afleveret (labelGraense i src/lib/fragt/types.ts).
  labelGraense?: number | null;
  // Køberens valgte fragtfirma (Shipmondo: dao | gls | postnord).
  transportoer?: string | null;
  // DAO: sælgeren har ikke accepteret (den aktuelle version af) DAO's
  // handelsbetingelser endnu - vis afkrydsningen.
  kraeverDaoAccept?: boolean;
}) {
  const id = useId();
  const router = useRouter();
  const [a, setA] = useState<Afsender>(afsender);
  const [fejl, setFejl] = useState<string | null>(null);
  const [feltFejl, setFeltFejl] = useState<FeltFejl>({});
  const [arbejder, setArbejder] = useState(false);
  // Knappen er slået fra, til siden er hydreret (src/lib/useHydreret.ts).
  const hydreret = useHydreret();
  const laas = useRef(false);
  const fejlRef = useRef<HTMLDivElement>(null);
  // DAO's handelsbetingelser: vises, når siden siger det, eller når serveren
  // svarer "dao_betingelser" (fx en ny version).
  const [visDao, setVisDao] = useState(kraeverDaoAccept);
  const [daoAccept, setDaoAccept] = useState(false);
  const [daoFejl, setDaoFejl] = useState<string | null>(null);
  const daoRef = useRef<HTMLInputElement>(null);

  function saet<K extends keyof Afsender>(k: K, v: string) {
    setA((x) => {
      const ny = { ...x, [k]: v };
      if (k === "postnummer") {
        const opslag = slaaPostnummerOp(v);
        if (opslag && (!x.by || slaaPostnummerOp(x.postnummer)?.by === x.by)) ny.by = opslag.by;
      }
      return ny;
    });
    if (feltFejl[k]) setFeltFejl((f) => ({ ...f, [k]: undefined }));
  }

  async function lav(medAdresse: boolean) {
    if (laas.current) return;
    if (visDao && !daoAccept) {
      setDaoFejl(DAO_BETINGELSER_FEJL);
      daoRef.current?.focus();
      return;
    }
    laas.current = true;
    setArbejder(true);
    setFejl(null);
    try {
      const r = await lavFragtlabel(tradeId, medAdresse ? a : undefined, visDao && daoAccept);
      if ("fejl" in r && r.kode === DAO_BETINGELSER_KODE) {
        setVisDao(true);
        setDaoAccept(false);
        setDaoFejl(r.fejl);
        requestAnimationFrame(() => daoRef.current?.focus());
      } else if ("fejl" in r) {
        setFejl(r.fejl);
        requestAnimationFrame(() => fejlRef.current?.focus());
      } else router.refresh();
    } catch {
      setFejl("Noget gik galt. Prøv igen om lidt.");
    } finally {
      laas.current = false;
      setArbejder(false);
    }
  }

  async function aabnLabel(fid: string) {
    setFejl(null);
    // Vinduet åbnes med det samme (ellers blokerer browseren det efter await).
    const vindue = window.open("", "_blank");
    // Den nye fane må ikke kunne styre BidHamr-fanen (window.opener).
    if (vindue) vindue.opener = null;
    try {
      const r = await hentFragtlabelLink(fid);
      if ("fejl" in r) {
        vindue?.close();
        setFejl(r.fejl);
      } else if (vindue) {
        vindue.location.href = r.url;
      } else window.location.href = r.url;
    } catch {
      vindue?.close();
      setFejl("Noget gik galt. Prøv igen om lidt.");
    }
  }

  // Fragtfirmaet: labelens (når den findes), ellers køberens valg.
  const t = forsendelse?.transportoer ?? transportoer;
  const info = erTransportoer(t) ? TRANSPORTOER_INFO[t] : null;
  const shopNavn = info?.shopNavn ?? "daoSHOP";

  const fejlBoks = fejl && (
    <div ref={fejlRef} tabIndex={-1} role="alert" className="mt-4 rounded-xl border border-fejl-kant bg-fejl-bg px-4 py-3 text-sm text-fejl-tekst outline-none">
      {fejl}
      {/2 fragtlabels|Skriv til BidHamr/.test(fejl) && (
        <Link href="/kontakt" className="mt-2 block font-semibold underline underline-offset-2">
          Skriv til BidHamr
        </Link>
      )}
    </div>
  );

  // DAO's handelsbetingelser (kun når accepten mangler).
  const daoAfkrydsning = visDao && (
    <div className="mt-4">
      <label htmlFor={`${id}-dao`} className="flex cursor-pointer items-start gap-3 text-sm text-tekst">
        <input
          ref={daoRef}
          id={`${id}-dao`}
          type="checkbox"
          checked={daoAccept}
          onChange={(e) => {
            setDaoAccept(e.target.checked);
            if (e.target.checked) setDaoFejl(null);
          }}
          aria-invalid={daoFejl ? true : undefined}
          aria-describedby={daoFejl ? `${id}-dao-fejl` : undefined}
          className="mt-0.5 h-5 w-5 shrink-0 accent-groen"
        />
        <span>
          {DAO_BETINGELSER_ACCEPT_TEKST} (
          <a
            href={DAO_BETINGELSER.url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-groen-mork underline underline-offset-2"
          >
            læs DAO&apos;s handelsbetingelser
          </a>
          ).
        </span>
      </label>
      {daoFejl && (
        <p id={`${id}-dao-fejl`} className="mt-1.5 text-[13px] font-medium text-fejl-tekst">
          {daoFejl}
        </p>
      )}
    </div>
  );

  // ------------------------------------------------------------ labelen findes
  if (forsendelse && forsendelse.status !== "opretter" && forsendelse.status !== "annulleres") {
    return (
      <section aria-labelledby={`${id}-titel`} className="rounded-none border border-kant bg-white p-5 sm:p-6">
        <h2 id={`${id}-titel`} className="text-[17px] leading-snug lg:text-lg">
          Din fragtlabel er klar
        </h2>
        {info && <p className="mt-1 text-sm text-tekst-svag">Fragtfirma: {info.navn}</p>}

        {forsendelse.qrBillede && (
          <div className="mt-4 rounded-xl bg-groen-lys p-4 text-center sm:p-5">
            <p className="text-sm font-semibold text-groen-mork">Vis QR-koden i en {shopNavn}</p>
            <Image
              src={forsendelse.qrBillede}
              alt={`QR-kode til at aflevere pakken hos ${info?.navn ?? "fragtfirmaet"}`}
              width={220}
              height={220}
              unoptimized
              className="mx-auto mt-3 h-[220px] w-[220px] rounded-lg bg-white p-2 [image-rendering:pixelated]"
            />
            <p className="mx-auto mt-2 max-w-[44ch] text-[13px] text-tekst-daempet">
              Du behøver ikke en printer. Vis QR-koden på din mobil, når du afleverer pakken, så printer
              pakkeshoppen labelen.
            </p>
          </div>
        )}

        {forsendelse.labelfriKode && !forsendelse.qrBillede && (
          <div className="mt-4 rounded-xl bg-groen-lys p-4 text-center sm:p-5">
            <p className="text-sm font-semibold text-groen-mork">Vis denne kode i en {shopNavn}</p>
            <p
              className="mt-2 font-mono text-[28px] leading-tight font-bold tracking-[0.08em] break-all text-tekst sm:text-[34px]"
              aria-label={`Labelfri-kode: ${forsendelse.labelfriKode.split("").join(" ")}`}
            >
              {forsendelse.labelfriKode}
            </p>
            <p className="mx-auto mt-2 max-w-[44ch] text-[13px] text-tekst-daempet">
              Du behøver ikke en printer. Vis koden, når du afleverer pakken i en {shopNavn}. Du kan også skrive
              koden tydeligt på pakken.
            </p>
          </div>
        )}

        {!forsendelse.labelfriKode && !forsendelse.qrBillede && forsendelse.harLabel && (
          <p className="mt-4 rounded-xl bg-groen-lys px-4 py-3 text-sm text-tekst-daempet">
            Print labelen, og sæt den på pakken. Aflever pakken i en {info?.shopNavn ?? "pakkeshop"}.
            {info && info.labelfri === null && ` ${info.navn} kan ikke tage imod pakken uden en printet label.`}
          </p>
        )}

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          {forsendelse.harLabel && (
            <button
              type="button"
              onClick={() => void aabnLabel(forsendelse.id)}
              className={`btn ${forsendelse.labelfriKode || forsendelse.qrBillede ? "btn-sekundaer" : "btn-primaer"} w-full sm:w-auto`}
            >
              <Ikon navn="hent" className="h-[18px] w-[18px]" />
              Hent label (PDF)
            </button>
          )}
          {forsendelse.status === "oprettet" && (
            <BekraeftDialog
              triggerLabel="Annullér label"
              triggerClassName="btn btn-fare w-full sm:w-auto"
              title="Annullér fragtlabelen?"
              description={
                labelGraense === null
                  ? "En annulleret label og dens kode kan ikke bruges. Du kan lave en ny label bagefter. Har du allerede afleveret pakken, skal du ikke annullere labelen."
                  : `En annulleret label kan ikke bruges. Du kan højst lave ${labelGraense} labels til en handel – også dem, du har annulleret. Har du allerede afleveret pakken, skal du ikke annullere labelen.`
              }
              confirmLabel="Annullér label"
              cancelLabel="Behold label"
              onConfirm={async () => {
                const r = await annullerFragtlabel(tradeId, forsendelse.id);
                return "fejl" in r ? { fejl: r.fejl } : undefined;
              }}
              onSuccess={() => router.refresh()}
            />
          )}
        </div>

        {fejlBoks}

        <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          {forsendelse.sporingsnummer && (
            <>
              <dt className="text-tekst-svag">Sporingsnummer</dt>
              <dd className="font-mono font-medium break-all text-tekst">{forsendelse.sporingsnummer}</dd>
            </>
          )}
          {pakke && (
            <>
              <dt className="text-tekst-svag">Pakke</dt>
              <dd className="text-tekst">{pakke}</dd>
            </>
          )}
          {levering && (
            <>
              <dt className="text-tekst-svag">Leveres til</dt>
              <dd className="break-words text-tekst">{levering}</dd>
            </>
          )}
        </dl>

        <div className="mt-5 border-t border-kant pt-4">
          <h3 className="mb-3 text-[15px] font-semibold text-tekst">Sporing</h3>
          <SporingTidslinje f={forsendelse} />
        </div>

        <p className="mt-4 rounded-lg bg-groen-lys px-4 py-3 text-[13px] text-tekst-daempet">
          Husk at tage de to pakkebilleder og trykke “Marker som sendt” herunder. Det skal du gøre, selvom du har
          afleveret pakken.
        </p>
      </section>
    );
  }

  // ------------------------------------------------------------ labelen er ved at blive lavet
  if (forsendelse) {
    const annulleres = forsendelse.status === "annulleres";
    return (
      <section aria-labelledby={`${id}-titel`} className="rounded-none border border-info-kant bg-info-bg p-5 text-info-tekst sm:p-6">
        <h2 id={`${id}-titel`} className="text-[17px] leading-snug lg:text-lg">
          {annulleres ? "Labelen er ved at blive annulleret" : "Labelen er ved at blive lavet"}
        </h2>
        <p className="mt-1 text-sm">
          {annulleres
            ? "Opdatér siden om lidt."
            : "Fragtfirmaet har ikke svaret endnu. Vent et minut, og prøv igen. Du får ikke to labels."}
        </p>
        {!annulleres && daoAfkrydsning}
        <div className="mt-4 flex flex-wrap gap-3">
          {!annulleres && (
            <button
              type="button"
              onClick={() => void lav(false)}
              disabled={arbejder}
              aria-busy={arbejder || undefined}
              className="btn btn-primaer w-full sm:w-auto"
            >
              {arbejder && <span className="btn-spinner" aria-hidden="true" />}
              Prøv igen
            </button>
          )}
          <button type="button" onClick={() => router.refresh()} className="btn btn-sekundaer w-full sm:w-auto">
            Opdatér
          </button>
        </div>
        {fejlBoks}
      </section>
    );
  }

  // ------------------------------------------------------------ ingen label endnu
  return (
    <section aria-labelledby={`${id}-titel`} className="rounded-none border border-kant bg-white p-5 sm:p-6">
      <h2 id={`${id}-titel`} className="text-[17px] leading-snug lg:text-lg">
        Lav fragtlabel
      </h2>
      <p className="mt-1 text-sm text-tekst-svag">
        {info?.labelfri === "qr"
          ? `Køberen har betalt fragten og valgt ${info.navn}. Du får en QR-kode, som du viser i en ${info.shopNavn}, når du afleverer pakken. Du behøver ikke en printer, men du kan også hente labelen som PDF.`
          : info && info.labelfri === null
            ? `Køberen har betalt fragten og valgt ${info.navn}. Du får en label (PDF), som du printer og sætter på pakken, før du afleverer den i en ${info.shopNavn}.`
            : `Køberen har betalt fragten${info ? ` og valgt ${info.navn}` : ""}. Du får en kode, som du viser i en ${shopNavn}, når du afleverer pakken. Du behøver ikke en printer, men du kan også hente labelen som PDF.`}
      </p>

      {(pakke || levering) && (
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-xl bg-groen-lys px-4 py-3 text-sm">
          {pakke && (
            <>
              <dt className="text-tekst-daempet">Pakke</dt>
              <dd className="font-medium text-tekst">{pakke}</dd>
            </>
          )}
          {levering && (
            <>
              <dt className="text-tekst-daempet">Leveres til</dt>
              <dd className="font-medium break-words text-tekst">{levering}</dd>
            </>
          )}
        </dl>
      )}

      <form
        method="post"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const f = validerAfsender(a);
          setFeltFejl(f);
          const foerste = (Object.keys(f) as (keyof Afsender)[])[0];
          if (foerste) {
            document.getElementById(`${id}-${foerste}`)?.focus();
            return;
          }
          void lav(true);
        }}
        className="mt-5"
      >
        <fieldset className="min-w-0" disabled={arbejder}>
          <legend className="mb-2 text-sm font-medium text-tekst">Din adresse (afsender)</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <Felt id={`${id}-navn`} fejl={feltFejl.navn} label="Fulde navn" className="sm:col-span-2">
              <input id={`${id}-navn`} aria-invalid={feltFejl.navn ? true : undefined} aria-describedby={feltFejl.navn ? `${id}-navn-fejl` : undefined} minLength={2} maxLength={100} autoComplete="name" value={a.navn} onChange={(e) => saet("navn", e.target.value)} className={feltKlasse(!!feltFejl.navn)} />
            </Felt>
            <Felt id={`${id}-adresse`} fejl={feltFejl.adresse} label="Adresse" className="sm:col-span-2">
              <input id={`${id}-adresse`} aria-invalid={feltFejl.adresse ? true : undefined} aria-describedby={feltFejl.adresse ? `${id}-adresse-fejl` : undefined} minLength={3} maxLength={200} autoComplete="street-address" placeholder="Vejnavn og husnummer" value={a.adresse} onChange={(e) => saet("adresse", e.target.value)} className={feltKlasse(!!feltFejl.adresse)} />
            </Felt>
            <Felt id={`${id}-postnummer`} fejl={feltFejl.postnummer} label="Postnummer">
              <input
                id={`${id}-postnummer`} aria-invalid={feltFejl.postnummer ? true : undefined} aria-describedby={feltFejl.postnummer ? `${id}-postnummer-fejl` : undefined}
                inputMode="numeric"
                autoComplete="postal-code"
                value={a.postnummer}
                onChange={(e) => saet("postnummer", e.target.value.replace(/\D/g, "").slice(0, 4))}
                className={feltKlasse(!!feltFejl.postnummer)}
              />
            </Felt>
            <Felt id={`${id}-by`} fejl={feltFejl.by} label="By">
              <input id={`${id}-by`} aria-invalid={feltFejl.by ? true : undefined} aria-describedby={feltFejl.by ? `${id}-by-fejl` : undefined} maxLength={80} autoComplete="address-level2" value={a.by} onChange={(e) => saet("by", e.target.value)} className={feltKlasse(!!feltFejl.by)} />
            </Felt>
            <Felt id={`${id}-telefon`} fejl={feltFejl.telefon} label="Mobilnummer (valgfrit)" className="sm:col-span-2">
              <input id={`${id}-telefon`} aria-invalid={feltFejl.telefon ? true : undefined} aria-describedby={feltFejl.telefon ? `${id}-telefon-fejl` : undefined} type="tel" maxLength={20} autoComplete="tel" inputMode="tel" value={a.telefon} onChange={(e) => saet("telefon", e.target.value)} className={`${feltKlasse(!!feltFejl.telefon)} sm:max-w-[260px]`} />
            </Felt>
          </div>
        </fieldset>
        {daoAfkrydsning}
        {fejlBoks}
        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
          <button type="submit" disabled={arbejder || !hydreret} aria-busy={arbejder || undefined} className="btn btn-primaer w-full sm:w-auto">
            {arbejder && <span className="btn-spinner" aria-hidden="true" />}
            Lav fragtlabel
          </button>
          {brugteLabels > 0 && labelGraense !== null && (
            <p className="text-[13px] text-tekst-daempet">
              Du har brugt {brugteLabels} af {labelGraense} labels på handlen.
            </p>
          )}
        </div>
      </form>
    </section>
  );
}

function Felt({
  id,
  label,
  fejl,
  className = "",
  children,
}: {
  id: string;
  label: string;
  fejl?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-tekst">
        {label}
      </label>
      {children}
      {fejl && (
        <p id={`${id}-fejl`} className="mt-1.5 text-[13px] font-medium text-fejl-tekst">
          {fejl}
        </p>
      )}
    </div>
  );
}
