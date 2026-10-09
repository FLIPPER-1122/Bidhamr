"use client";

// "Send pakke" for sælgeren på handelssiden (kun når FRAGT_LABELS_AKTIV=true -
// tjekkes på serveren i siden og i actions):
//   1. Afsenderadresse (forudfyldt med den sidst brugte) -> "Lav fragtlabel".
//   2. DAO's labelfri-kode stort og tydeligt + "Hent label (PDF)".
//   3. Sporingstidslinje og "Annullér label".
// Pakkestørrelsen er altid auktionens. Fejl fra serveren er danske og vises
// direkte (fx højst 2 labels pr. handel).
// TODO(indhold): gennemse teksterne.
import Link from "next/link";
import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import BekraeftDialog from "@/components/BekraeftDialog";
import Ikon from "@/components/Ikon";
import SporingTidslinje from "@/components/fragt/SporingTidslinje";
import { annullerFragtlabel, hentFragtlabelLink, lavFragtlabel } from "@/app/actions/fragt";
import type { ForsendelseVisning } from "@/lib/fragt/handlinger";
import { slaaPostnummerOp } from "@/lib/postnumre";

export type Afsender = { navn: string; adresse: string; postnummer: string; by: string; telefon: string };

const feltKlasse = (fejl: boolean) =>
  `h-11 w-full rounded-xl border bg-white px-4 text-[15px] text-tekst placeholder:text-pladsholder focus:border-groen focus:outline-2 focus:outline-groen/25 disabled:cursor-not-allowed disabled:bg-[#F7F7F7] ${
    fejl ? "border-fejl-kant bg-fejl-bg/40" : "border-kant-staerk hover:border-[#BFBFBF]"
  }`;

const MAKS_LABELS = 2;

export default function FragtlabelBoks({
  tradeId,
  forsendelse,
  afsender,
  pakke,
  levering,
  brugteLabels,
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
}) {
  const id = useId();
  const router = useRouter();
  const [a, setA] = useState<Afsender>(afsender);
  const [fejl, setFejl] = useState<string | null>(null);
  const [arbejder, setArbejder] = useState(false);
  const laas = useRef(false);
  const fejlRef = useRef<HTMLDivElement>(null);

  function saet<K extends keyof Afsender>(k: K, v: string) {
    setA((x) => {
      const ny = { ...x, [k]: v };
      if (k === "postnummer") {
        const opslag = slaaPostnummerOp(v);
        if (opslag && (!x.by || slaaPostnummerOp(x.postnummer)?.by === x.by)) ny.by = opslag.by;
      }
      return ny;
    });
  }

  async function lav(medAdresse: boolean) {
    if (laas.current) return;
    laas.current = true;
    setArbejder(true);
    setFejl(null);
    try {
      const r = await lavFragtlabel(tradeId, medAdresse ? a : undefined);
      if ("fejl" in r) {
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
    try {
      const r = await hentFragtlabelLink(fid);
      if ("fejl" in r) {
        vindue?.close();
        setFejl(r.fejl);
      } else if (vindue) {
        vindue.opener = null;
        vindue.location.href = r.url;
      } else window.location.href = r.url;
    } catch {
      vindue?.close();
      setFejl("Noget gik galt. Prøv igen om lidt.");
    }
  }

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

  // ------------------------------------------------------------ labelen findes
  if (forsendelse && forsendelse.status !== "opretter" && forsendelse.status !== "annulleres") {
    return (
      <section aria-labelledby={`${id}-titel`} className="rounded-[14px] border border-kant bg-white p-5 sm:p-6">
        <h2 id={`${id}-titel`} className="text-[17px] leading-snug lg:text-lg">
          Din fragtlabel er klar
        </h2>

        {forsendelse.labelfriKode && (
          <div className="mt-4 rounded-xl bg-groen-lys p-4 text-center sm:p-5">
            <p className="text-sm font-semibold text-groen-mork">Vis denne kode i pakkeshoppen</p>
            <p
              className="mt-2 font-mono text-[28px] leading-tight font-bold tracking-[0.08em] break-all text-tekst sm:text-[34px]"
              aria-label={`Labelfri-kode: ${forsendelse.labelfriKode.split("").join(" ")}`}
            >
              {forsendelse.labelfriKode}
            </p>
            <p className="mx-auto mt-2 max-w-[44ch] text-[13px] text-tekst-daempet">
              Pakkeshoppen printer labelen for dig – du behøver ikke en printer. Du kan også skrive koden
              tydeligt på pakken.
            </p>
          </div>
        )}

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          {forsendelse.harLabel && (
            <button
              type="button"
              onClick={() => void aabnLabel(forsendelse.id)}
              className={`btn ${forsendelse.labelfriKode ? "btn-sekundaer" : "btn-primaer"} w-full sm:w-auto`}
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
              description={`Labelen kan ikke bruges bagefter. DAO kan ikke annullere labels gennem os, så vi annullerer den hos BidHamr og beder DAO om at kreditere den. Du kan højst lave ${MAKS_LABELS} labels til en handel (også annullerede).`}
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
          Husk at tage de to pakkebilleder og markere pakken sendt herunder.
        </p>
      </section>
    );
  }

  // ------------------------------------------------------------ labelen er ved at blive lavet
  if (forsendelse) {
    const annulleres = forsendelse.status === "annulleres";
    return (
      <section aria-labelledby={`${id}-titel`} className="rounded-[14px] border border-info-kant bg-info-bg p-5 text-info-tekst sm:p-6">
        <h2 id={`${id}-titel`} className="text-[17px] leading-snug lg:text-lg">
          {annulleres ? "Labelen er ved at blive annulleret" : "Labelen er ved at blive lavet"}
        </h2>
        <p className="mt-1 text-sm">
          {annulleres
            ? "Opdatér siden om lidt."
            : "Fragtfirmaet har ikke svaret endnu. Vent et minut, og prøv igen – du får ikke to labels."}
        </p>
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
    <section aria-labelledby={`${id}-titel`} className="rounded-[14px] border border-kant bg-white p-5 sm:p-6">
      <h2 id={`${id}-titel`} className="text-[17px] leading-snug lg:text-lg">
        Lav fragtlabel
      </h2>
      <p className="mt-1 text-sm text-tekst-svag">
        Fragten er betalt af køberen. Du får en kode, du viser i pakkeshoppen, og en label som PDF.
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
        onSubmit={(e) => {
          e.preventDefault();
          void lav(true);
        }}
        className="mt-5"
      >
        <fieldset className="min-w-0" disabled={arbejder}>
          <legend className="mb-2 text-sm font-medium text-tekst">Din adresse (afsender)</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <Felt id={`${id}-navn`} label="Fulde navn" className="sm:col-span-2">
              <input id={`${id}-navn`} required minLength={2} maxLength={100} autoComplete="name" value={a.navn} onChange={(e) => saet("navn", e.target.value)} className={feltKlasse(false)} />
            </Felt>
            <Felt id={`${id}-adresse`} label="Adresse" className="sm:col-span-2">
              <input id={`${id}-adresse`} required minLength={3} maxLength={200} autoComplete="street-address" placeholder="Vejnavn og husnummer" value={a.adresse} onChange={(e) => saet("adresse", e.target.value)} className={feltKlasse(false)} />
            </Felt>
            <Felt id={`${id}-postnummer`} label="Postnummer">
              <input
                id={`${id}-postnummer`}
                required
                pattern="\d{4}"
                inputMode="numeric"
                autoComplete="postal-code"
                value={a.postnummer}
                onChange={(e) => saet("postnummer", e.target.value.replace(/\D/g, "").slice(0, 4))}
                className={feltKlasse(false)}
              />
            </Felt>
            <Felt id={`${id}-by`} label="By">
              <input id={`${id}-by`} required maxLength={80} autoComplete="address-level2" value={a.by} onChange={(e) => saet("by", e.target.value)} className={feltKlasse(false)} />
            </Felt>
            <Felt id={`${id}-telefon`} label="Mobilnummer (valgfrit)" className="sm:col-span-2">
              <input id={`${id}-telefon`} type="tel" maxLength={20} autoComplete="tel" inputMode="tel" value={a.telefon} onChange={(e) => saet("telefon", e.target.value)} className={`${feltKlasse(false)} sm:max-w-[260px]`} />
            </Felt>
          </div>
        </fieldset>
        {fejlBoks}
        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
          <button type="submit" disabled={arbejder} aria-busy={arbejder || undefined} className="btn btn-primaer w-full sm:w-auto">
            {arbejder && <span className="btn-spinner" aria-hidden="true" />}
            Lav fragtlabel
          </button>
          {brugteLabels > 0 && (
            <p className="text-[13px] text-tekst-daempet">
              Du har brugt {brugteLabels} af {MAKS_LABELS} labels på handlen.
            </p>
          )}
        </div>
      </form>
    </section>
  );
}

function Felt({ id, label, className = "", children }: { id: string; label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-tekst">
        {label}
      </label>
      {children}
    </div>
  );
}
