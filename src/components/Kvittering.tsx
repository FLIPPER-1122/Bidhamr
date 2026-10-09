// Kvittering (køber) / afregning (sælger) for en handel. Server-komponent:
// data hentes af siden via hentMinKvittering og indeholder kun brugerens
// egne beløb. Samme opdeling som i mailen (kvitteringLinjer).
import Image from "next/image";
import Link from "next/link";
import {
  kvitteringFakturaTekst,
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
    <section className="rounded-[14px] border border-kant bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[17px] leading-snug lg:text-lg">{kvitteringOverskrift(k)}</h2>
        <Link
          href={`/mine-handler/${k.handelId}/kvittering`}
          className="inline-flex min-h-11 items-center rounded-md text-sm font-medium text-groen underline hover:text-groen-mork focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
        >
          Vis og udskriv
        </Link>
      </div>
      <div className="mt-3">
        <Beloebslinjer k={k} />
      </div>
      <p className="mt-3 text-xs text-tekst-svag">{kvitteringFakturaTekst(k)}</p>
    </section>
  );
}

// Fuld kvittering til udskrift.
export function KvitteringFuld({ k }: { k: Kvittering }) {
  const erKoeber = k.rolle === "koeber";
  return (
    <article data-kvittering-udskrift className="rounded-[14px] border border-kant bg-white p-5 sm:p-8 print:border-0 print:p-0">
      <Image src="/brand/bidhamr-logo.svg" alt="BidHamr" width={230} height={60} unoptimized className="h-8 w-auto" />
      <h1 className="mt-4 text-[26px] leading-tight sm:text-[32px]">{kvitteringOverskrift(k)}</h1>
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
            <dt className="text-tekst-svag">Pengene sendt tilbage</dt>
            <dd className="font-medium text-tekst">{kvitteringDato(k.refunderetKl)}</dd>
          </div>
        )}
      </dl>

      <div className="mt-6 rounded-xl bg-groen-lys px-4 py-2 print:bg-white print:px-0">
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
        <p>{kvitteringFakturaTekst(k)}</p>
        <p>{KVITTERING_STRIPE}</p>
        <p>BidHamr · bidhamr.dk · support@bidhamr.dk</p>
      </div>
    </article>
  );
}
