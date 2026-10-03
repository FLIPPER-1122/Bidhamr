// Kvittering (køber) / afregning (sælger) for en handel. Server-komponent:
// data hentes af siden via hentMinKvittering og indeholder kun brugerens
// egne beløb. Samme opdeling som i mailen (kvitteringLinjer).
import Link from "next/link";
import {
  KVITTERING_IKKE_FAKTURA,
  KVITTERING_STRIPE,
  kvitteringDato,
  kvitteringKroner,
  kvitteringLinjer,
  type Kvittering,
} from "@/lib/kvittering";

function Beloebslinjer({ k }: { k: Kvittering }) {
  return (
    <dl className="divide-y divide-kant">
      {kvitteringLinjer(k).map((l) => (
        <div
          key={l.tekst}
          className={`flex items-baseline justify-between gap-4 py-2 text-sm ${
            l.fremhaev ? "font-semibold text-tekst" : "text-tekst-daempet"
          }`}
        >
          <dt>{l.tekst}</dt>
          <dd className="tabular-nums whitespace-nowrap">
            {l.fratraek ? "− " : ""}
            {kvitteringKroner(l.oere)} kr
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function kvitteringOverskrift(k: Kvittering) {
  return k.rolle === "koeber" ? "Kvittering for dit køb" : "Afregning for dit salg";
}

// Kort udgave til handelssiden med link til den fulde, udskrivbare kvittering.
export function KvitteringBoks({ k }: { k: Kvittering }) {
  return (
    <section className="rounded-xl border border-kant bg-white p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-tekst">{kvitteringOverskrift(k)}</h2>
        <Link
          href={`/mine-handler/${k.handelId}/kvittering`}
          className="text-sm font-medium text-groen underline hover:text-groen-mork"
        >
          Vis og udskriv
        </Link>
      </div>
      <div className="mt-3">
        <Beloebslinjer k={k} />
      </div>
      <p className="mt-3 text-xs text-tekst-svag">{KVITTERING_IKKE_FAKTURA}</p>
    </section>
  );
}

// Fuld kvittering til udskrift.
export function KvitteringFuld({ k }: { k: Kvittering }) {
  const erKoeber = k.rolle === "koeber";
  return (
    <article data-kvittering-udskrift className="rounded-xl border border-kant bg-white p-6 sm:p-8 print:border-0 print:p-0">
      <p className="text-lg font-bold text-groen">BidHamr</p>
      <h1 className="mt-4 font-serif text-2xl font-semibold text-tekst">{kvitteringOverskrift(k)}</h1>
      <p className="mt-1 text-sm text-tekst-daempet">Kvittering/handelsbekræftelse – ikke en faktura</p>

      <dl className="mt-6 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-tekst-svag">Vare</dt>
          <dd className="font-medium text-tekst">{k.titel}</dd>
        </div>
        <div>
          <dt className="text-tekst-svag">{erKoeber ? "Sælger" : "Køber"}</dt>
          <dd className="font-medium text-tekst">{k.modpartNavn}</dd>
        </div>
        <div>
          <dt className="text-tekst-svag">{erKoeber ? "Betalt" : "Afsluttet"}</dt>
          <dd className="font-medium text-tekst">{kvitteringDato(k.dato)}</dd>
        </div>
        <div>
          <dt className="text-tekst-svag">Handels-id</dt>
          <dd className="break-all font-mono text-xs text-tekst">{k.handelId}</dd>
        </div>
        <div>
          <dt className="text-tekst-svag">Levering</dt>
          <dd className="font-medium text-tekst">{k.afhentning ? "Afhentning hos sælger" : "Forsendelse"}</dd>
        </div>
        {k.rolle === "koeber" && k.refunderetKl && (
          <div>
            <dt className="text-tekst-svag">Refunderet</dt>
            <dd className="font-medium text-tekst">{kvitteringDato(k.refunderetKl)}</dd>
          </div>
        )}
      </dl>

      <div className="mt-6 rounded-lg bg-neutral-50 px-4 py-2 print:bg-white print:px-0">
        <Beloebslinjer k={k} />
      </div>

      <div className="mt-6 space-y-2 text-sm text-tekst-daempet">
        {k.rolle === "saelger" && (
          <p>
            Udbetalingen er salgsprisen minus 5 % i sælgergebyr og sendes til din udbetalingskonto
            hos vores betalingspartner Stripe.
            {!k.afhentning &&
              " Fragten betaler køberen, og den går til fragtfirmaet – den indgår ikke i din udbetaling."}
          </p>
        )}
        <p>{KVITTERING_IKKE_FAKTURA}</p>
        <p>{KVITTERING_STRIPE}</p>
        <p>BidHamr · bidhamr.dk · support@bidhamr.dk</p>
      </div>
    </article>
  );
}
