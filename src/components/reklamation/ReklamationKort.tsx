// "Vi reklamerer hos DAO for dig" på sælgerens handelsside
// (ROADMAP-BESLUTNINGER afsnit 4, "Reklamation – BidHamr anmelder, chefen
// udbetaler", Filip 22. okt. 2026). Kun en statusvisning: BidHamr anmelder
// skaden og udbetaler erstatningen, når fragtfirmaet har betalt BidHamr.
// Sælgeren skal ikke gøre noget og ser aldrig anmeldelsens oplysninger,
// billederne eller fragtfirmaets anmeldelsesside.
// Server-komponent uden klientkode.
import {
  REKLAMATION_TRIN_SAELGER,
  kroner,
  reklamationStatusSaelger,
  reklamationTrin,
  reklamationUdbetalingTrin,
  transportoerNavn,
  type SaelgerReklamation,
} from "@/lib/reklamation/typer";
import ReklamationMaerke from "./ReklamationMaerke";

function dato(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString("da-DK", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Copenhagen",
  });
}

function Forklaring({ r }: { r: SaelgerReklamation }) {
  const navn = transportoerNavn(r.transportoer);
  switch (r.status) {
    case "afventer_bidhamr":
      return (
        <>
          Varen blev skadet under fragten, og køberen har fået pengene tilbage. Du pakkede varen ordentligt, så vi
          reklamerer hos {navn} for dig – du skal ikke selv gøre noget. Vi kræver op til {kroner(r.kravbeloeb_oere)} Du
          hører fra os, når der er nyt.
        </>
      );
    case "anmeldt":
      return (
        <>
          Vi har anmeldt skaden hos {navn}{r.anmeldt_kl ? ` ${dato(r.anmeldt_kl)}` : ""}. Det er {navn}, der afgør, om du
          får erstatning. Vi giver dig besked, når {navn} har svaret.
        </>
      );
    case "godkendt":
      return (
        <>
          {navn} har godkendt en erstatning på {kroner(r.godkendt_beloeb_oere)} Vi udbetaler pengene til dig, når {navn} har
          betalt os. Du får besked, når pengene er på vej.
        </>
      );
    case "udbetalt":
      // "Udbetalt" og "1-3 bankdage" først, når payouten til banken er sendt.
      switch (reklamationUdbetalingTrin(r)) {
        case "betalt":
          return (
            <>
              Vi har udbetalt {kroner(r.godkendt_beloeb_oere)} i erstatning til dig, og pengene er sendt til din
              bankkonto.
            </>
          );
        case "sendt":
          return (
            <>
              Erstatningen på {kroner(r.godkendt_beloeb_oere)} er sendt til din bank via vores betalingspartner Stripe.
              Der går normalt 1-3 bankdage, før pengene står på din konto.
            </>
          );
        case "bank_fejlet":
          return (
            <>
              Vores betalingspartner Stripe kunne ikke sende erstatningen på {kroner(r.godkendt_beloeb_oere)} til din
              bankkonto. Ret dine bankoplysninger under Min konto – så sendes pengene automatisk igen.
            </>
          );
        case "problem":
          return (
            <>
              Der er opstået et problem med udbetalingen af din erstatning – vi kigger på det og giver dig besked.
            </>
          );
        default:
          return (
            <>
              {navn} har betalt erstatningen på {kroner(r.godkendt_beloeb_oere)}, og vi er ved at sende pengene til din
              bankkonto. Du får besked, når pengene er sendt.
            </>
          );
      }
    case "afvist":
      return (
        <>
          {navn} har afvist reklamationen, så du får desværre ikke erstatning for varen.
          {r.afvisningsgrund ? ` Begrundelse fra ${navn}: ${r.afvisningsgrund}` : ""}
        </>
      );
    case "annulleret":
      return <>Vi har stoppet reklamationen.{r.annulleret_grund ? ` Begrundelse: ${r.annulleret_grund}` : ""}</>;
  }
}

function Trinliste({ status, ikkeSendt }: { status: SaelgerReklamation["status"]; ikkeSendt: boolean }) {
  const t = reklamationTrin(status);
  const trin = t.trin;
  // Udbetalt hos BidHamr, men ikke sendt til banken endnu: sidste trin er i gang.
  const faerdig = t.faerdig && !ikkeSendt;
  const stoppet = status === "afvist" || status === "annulleret";
  return (
    <ol className="mt-4 flex flex-col gap-2 sm:flex-row sm:gap-3" aria-label="Reklamationens forløb">
      {REKLAMATION_TRIN_SAELGER.map((tekst, i) => {
        const gjort = i < trin || (i === trin && faerdig && !stoppet);
        const nu = i === trin && !faerdig;
        return (
          <li
            key={tekst}
            aria-current={nu ? "step" : undefined}
            className={`flex flex-1 items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
              gjort
                ? "border-succes-kant bg-succes-bg text-succes-tekst"
                : nu
                  ? "border-groen bg-groen-lys font-semibold text-tekst"
                  : "border-kant bg-white text-tekst-svag"
            }`}
          >
            <span
              aria-hidden="true"
              className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold ${
                gjort ? "bg-succes-tekst text-white" : nu ? "bg-groen text-white" : "bg-kant text-tekst-daempet"
              }`}
            >
              {gjort ? "✓" : i + 1}
            </span>
            <span>
              <span className="sr-only">{gjort ? "Gjort: " : nu ? "Nu: " : "Senere: "}</span>
              {tekst}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export default function ReklamationKort({ r }: { r: SaelgerReklamation }) {
  const navn = transportoerNavn(r.transportoer);
  const slut = r.status === "afvist" || r.status === "annulleret";
  const udbetaling = reklamationUdbetalingTrin(r);
  const sendt = udbetaling === "betalt" || udbetaling === "sendt";
  const tone =
    sendt
      ? "border-succes-kant bg-succes-bg"
      : slut
        ? "border-kant bg-white"
        : "border-groen bg-white";

  return (
    <section
      id="reklamation"
      aria-labelledby="reklamation-titel"
      className={`scroll-mt-24 rounded-[14px] border-2 p-5 sm:p-6 ${tone}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="reklamation-titel" className="text-[20px] leading-tight lg:text-[22px]">
          {r.status === "afventer_bidhamr" ? `Vi reklamerer hos ${navn} for dig` : reklamationStatusSaelger(r.status, r.transportoer, udbetaling)}
        </h2>
        {r.status !== "afventer_bidhamr" && <ReklamationMaerke status={r.status} />}
      </div>
      <p className="mt-2 text-[15px] text-tekst-daempet">
        <Forklaring r={r} />
      </p>
      {!slut && <Trinliste status={r.status} ikkeSendt={udbetaling !== null && !sendt} />}
      {r.sag_aendret && !slut && r.status !== "udbetalt" && (
        <p role="status" className="mt-4 rounded-xl border border-advarsel-kant bg-advarsel-bg px-4 py-3 text-sm text-advarsel-tekst">
          Sagen om handlen er ændret, og vi kigger på, hvad det betyder for reklamationen. Du hører fra os.
        </p>
      )}
      {slut && (
        <p className="mt-3 text-sm text-tekst-daempet">Har du spørgsmål, så skriv til support@bidhamr.dk.</p>
      )}
    </section>
  );
}
