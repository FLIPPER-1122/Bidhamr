import Link from "next/link";
import type { Udbetalingsvisning } from "@/app/actions/betaling";
import { kroner } from "@/lib/kroner";

// Sælgerens udbetalingsstatus på handelssiden (betalingsmodel destination):
// pengene sendes fra sælgerens Stripe-konto til banken, når handlen er helt
// færdig. Ingen interne fejltekster - kun faste danske tekster.

function dato(iso: string) {
  return new Date(iso).toLocaleString("da-DK", {
    timeZone: "Europe/Copenhagen",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function UdbetalingStatusBoks({ v }: { v: Udbetalingsvisning }) {
  const beloeb = kroner(v.beloebOere);
  let titel: string;
  let tekst: string;
  let stil: string;
  switch (v.status) {
    case "udbetalt":
      titel = "Pengene er sendt til din bank";
      tekst = `Vores betalingspartner Stripe har sendt ${beloeb} til din bankkonto${v.sendtKl ? ` (${dato(v.sendtKl)})` : ""}.`;
      stil = "border-succes-kant bg-groen-lys text-groen-mork";
      break;
    case "paa_vej":
      titel = "Udbetalingen er på vej";
      tekst = `Vores betalingspartner Stripe sender ${beloeb} til din bankkonto. Der går normalt 1-3 bankdage.`;
      stil = "border-info-kant bg-info-bg text-info-tekst";
      break;
    case "venter_paa_bank":
      titel = "Udbetalingen til din bank fejlede";
      tekst =
        "Stripe kunne ikke sende pengene til din bankkonto. Ret dine bankoplysninger under Min konto – så sendes pengene automatisk igen.";
      stil = "border-fejl-kant bg-fejl-bg text-fejl-tekst";
      break;
    case "kraever_handling":
      titel = "Din udbetalingskonto mangler noget";
      tekst =
        "Pengene kan ikke sendes til din bank endnu. Åbn Min konto, og gør din udbetalingskonto hos vores betalingspartner Stripe færdig. Så sendes pengene automatisk.";
      stil = "border-advarsel-kant bg-advarsel-bg text-advarsel-tekst";
      break;
    case "stoppet":
      titel = "Udbetalingen er sat på pause";
      tekst =
        "Udbetalingen venter, mens vi kigger på handlen. Du får besked, når pengene sendes. Har du spørgsmål, så skriv til support@bidhamr.dk.";
      stil = "border-advarsel-kant bg-advarsel-bg text-advarsel-tekst";
      break;
    default:
      titel = "Udbetalingen venter";
      tekst = v.tidligstKl
        ? `Handlen er færdig. ${beloeb} sendes til din bankkonto af vores betalingspartner Stripe – tidligst ${dato(v.tidligstKl)}.`
        : `Handlen er færdig. ${beloeb} sendes til din bankkonto af vores betalingspartner Stripe inden for kort tid.`;
      stil = "border-info-kant bg-info-bg text-info-tekst";
  }
  return (
    <div className={`rounded-[14px] border p-5 text-sm sm:p-6 ${stil}`}>
      <p className="font-semibold">{titel}</p>
      <p className="mt-1">{tekst}</p>
      {(v.status === "venter_paa_bank" || v.status === "kraever_handling") && (
        <Link href="/konto#udbetaling" className="btn btn-sekundaer mt-3 inline-flex w-full sm:w-auto">
          Gå til Min konto
        </Link>
      )}
    </div>
  );
}
