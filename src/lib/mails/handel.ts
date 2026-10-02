// Mailskabeloner til handelsflowet. Deles af cron-ruten (auktion afsluttet)
// og server actions (pakke sendt). Selve layoutet ligger i ./layout, så alle
// mails ser ens ud.
import { bygMail, escapeHtml, sideUrl, type InfoRaekke, type MailLayoutInput } from "./layout";

export { escapeHtml, sideUrl };

export const HANDEL_AFSENDER = "BidHamr <noreply@bidhamr.dk>";

const AARSAG_HANDEL = "Du får denne mail, fordi du er køber eller sælger i en handel på BidHamr.";
const MINE_HANDLER = { tekst: "Se alle dine handler", url: sideUrl("/mine-handler") };
const STRIPE_KOEBER =
  "Betalingen håndteres af vores betalingspartner Stripe. Sælgeren får udbetalingen, når du har bekræftet, at du har modtaget varen, og at den er som beskrevet.";

export function kronerFraOere(oere: number) {
  return (oere / 100).toLocaleString("da-DK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fristTekst(betalSenest: string) {
  return new Date(betalSenest).toLocaleString("da-DK", {
    timeZone: "Europe/Copenhagen",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function vare(titel: string): InfoRaekke {
  return { noegle: "Vare", vaerdiHtml: escapeHtml(titel) };
}

function beloeb(noegle: string, oere: number, fremhaev = false): InfoRaekke {
  return { noegle, vaerdiHtml: `${kronerFraOere(oere)}&nbsp;kr`, fremhaev };
}

// Fælles for handelsmails: link til "Mine handler" og fast årsagslinje,
// medmindre mailen selv angiver andet.
function handelsMail(
  subject: string,
  input: Omit<MailLayoutInput, "aarsag"> & { aarsag?: string },
) {
  return {
    subject,
    ...bygMail({ sekundaer: MINE_HANDLER, ...input, aarsag: input.aarsag ?? AARSAG_HANDEL }),
  };
}

// Vinderen skal selv betale inden for 24 timer.
export function koeberVandtMail(
  titel: string,
  totalOere: number,
  tradeId: string,
  betalSenest: string,
) {
  return handelsMail(`Du vandt auktionen: ${titel}`, {
    preheader: `Betal ${kronerFraOere(totalOere)} kr senest ${fristTekst(betalSenest)}.`,
    overskriftHtml: "Tillykke, du vandt",
    afsnitHtml: [
      `Du har vundet auktionen <strong>${escapeHtml(titel)}</strong>. Du skal betale ${kronerFraOere(totalOere)} kr i alt inkl. købergebyr, fragt og evt. BidHamr Beskyttelse.`,
      `Betal senest <strong>${fristTekst(betalSenest)}</strong>. Du kan betale med kort, MobilePay, Apple Pay eller Google Pay, og du kan tilvælge BidHamr Beskyttelse.`,
      STRIPE_KOEBER,
    ],
    info: [
      vare(titel),
      beloeb("At betale i alt", totalOere, true),
      { noegle: "Betal senest", vaerdiHtml: fristTekst(betalSenest) },
    ],
    knap: { tekst: "Betal nu", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

// Vinderens gemte kort blev trukket automatisk.
export function koeberAutobetaltMail(titel: string, totalOere: number, tradeId: string) {
  return handelsMail(`Du vandt og har betalt: ${titel}`, {
    preheader: `${kronerFraOere(totalOere)} kr er trukket på dit gemte kort.`,
    overskriftHtml: "Tillykke, du vandt",
    afsnitHtml: [
      `Du har vundet auktionen <strong>${escapeHtml(titel)}</strong>, og ${kronerFraOere(totalOere)} kr er trukket automatisk på dit gemte kort.`,
      STRIPE_KOEBER,
    ],
    info: [vare(titel), beloeb("Betalt i alt", totalOere, true)],
    knap: { tekst: "Se handlen", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

export function betalingsPaamindelseMail(
  titel: string,
  totalOere: number,
  tradeId: string,
  betalSenest: string,
) {
  return handelsMail(`Husk at betale: ${titel}`, {
    preheader: `Betal senest ${fristTekst(betalSenest)}, ellers annulleres handlen.`,
    overskriftHtml: "Du mangler at betale",
    afsnitHtml: [
      `Vi har endnu ikke modtaget din betaling på ${kronerFraOere(totalOere)} kr for <strong>${escapeHtml(titel)}</strong>.`,
      `Betal senest <strong>${fristTekst(betalSenest)}</strong>. Ellers bliver handlen annulleret, og du kan få en advarsel.`,
    ],
    info: [
      vare(titel),
      beloeb("At betale i alt", totalOere, true),
      { noegle: "Betal senest", vaerdiHtml: fristTekst(betalSenest) },
    ],
    knap: { tekst: "Betal nu", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

export function saelgerSolgtMail(titel: string, buddetOere: number, tradeId: string) {
  return handelsMail(`Din auktion er solgt: ${titel}`, {
    preheader: `Solgt for ${kronerFraOere(buddetOere)} kr. Vent med at sende, til køberen har betalt.`,
    overskriftHtml: "Din auktion er solgt",
    afsnitHtml: [
      `<strong>${escapeHtml(titel)}</strong> blev solgt for ${kronerFraOere(buddetOere)} kr.`,
      "Køberen har 24 timer til at betale. Vi giver dig besked, så snart betalingen er modtaget — send først varen derefter.",
      "Når køberen har bekræftet varen, overføres beløbet fratrukket 5% sælgergebyr til din udbetalingskonto hos vores betalingspartner Stripe.",
    ],
    info: [vare(titel), beloeb("Solgt for", buddetOere, true)],
    knap: { tekst: "Se handlen", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

export function saelgerBetaltMail(titel: string, tradeId: string) {
  return handelsMail(`Køberen har betalt: ${titel}`, {
    preheader: "Send varen og indtast sporingsnummeret på handelssiden.",
    overskriftHtml: "Betalingen er modtaget",
    afsnitHtml: [
      `Køberen har betalt for <strong>${escapeHtml(titel)}</strong>.`,
      "Send varen af sted og indtast sporingsnummeret på handelssiden.",
    ],
    knap: { tekst: "Se handlen", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

export function pakkeSendtMail(titel: string, tracking: string, tradeId: string) {
  return handelsMail(`Din pakke er sendt: ${titel}`, {
    preheader: `Sporingsnummer: ${tracking}`,
    overskriftHtml: "Pakken er på vej",
    afsnitHtml: [
      `Sælgeren har sendt <strong>${escapeHtml(titel)}</strong>.`,
      "Når pakken er kommet frem, kvitterer du for den på handelssiden. Derefter tjekker du varen og godkender den. Først da får sælgeren udbetalingen fra vores betalingspartner Stripe.",
    ],
    info: [vare(titel), { noegle: "Sporingsnummer", vaerdiHtml: escapeHtml(tracking) }],
    knap: { tekst: "Se handlen", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

// --- Vinderen betaler ikke ---------------------------------------------------

// Køberen betalte ikke inden fristen. Advarsel gives ikke automatisk.
export function koeberUbetaltAnnulleretMail(titel: string, tradeId: string) {
  return handelsMail(`Handlen er annulleret: ${titel}`, {
    preheader: "Vi modtog ikke din betaling inden fristen. Du er ikke blevet trukket for noget.",
    overskriftHtml: "Handlen er annulleret",
    afsnitHtml: [
      `Vi modtog ikke din betaling for <strong>${escapeHtml(titel)}</strong> inden fristen, så handlen er annulleret. Du er ikke blevet trukket for noget.`,
      "Når du byder, lover du at betale, hvis du vinder. En medarbejder ser på sagen, og du kan få en advarsel.",
    ],
    knap: { tekst: "Se handlen", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

export function saelgerUbetaltAnnulleretMail(titel: string, tradeId: string) {
  return handelsMail(`Køberen betalte ikke: ${titel}`, {
    preheader: "Du skal ikke sende varen. Vælg, hvad der skal ske nu.",
    overskriftHtml: "Køberen betalte ikke",
    afsnitHtml: [
      `Køberen af <strong>${escapeHtml(titel)}</strong> betalte ikke inden fristen, så handlen er annulleret. Du skal ikke sende varen.`,
      "Du bestemmer selv, hvad der skal ske nu. Du kan tilbyde varen til den næsthøjeste byder til byderens eget højeste bud. Eller du kan sætte varen op igen gratis.",
    ],
    knap: { tekst: "Vælg næste skridt", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

// Næste byder får tilbudt varen til sit eget højeste bud.
export function andenchanceTilbudMail(
  titel: string,
  budOere: number,
  tilbudId: string,
  udloeber: string,
) {
  return handelsMail(`Du kan købe ${titel}`, {
    preheader: `Du kan købe varen til dit eget bud. Svar senest ${fristTekst(udloeber)}.`,
    overskriftHtml: "Du får tilbudt varen",
    afsnitHtml: [
      `Auktionen <strong>${escapeHtml(titel)}</strong> blev ikke gennemført. Sælgeren tilbyder dig nu varen til dit eget højeste bud på ${kronerFraOere(budOere)} kr. Dertil kommer købergebyr, fragt og evt. BidHamr Beskyttelse.`,
      `Du har 24 timer til at svare – senest <strong>${fristTekst(udloeber)}</strong>. Siger du ja, har du 24 timer til at betale. Du skylder ikke noget, hvis du siger nej.`,
    ],
    info: [
      vare(titel),
      beloeb("Dit højeste bud", budOere, true),
      { noegle: "Svar senest", vaerdiHtml: fristTekst(udloeber) },
    ],
    knap: { tekst: "Se tilbuddet", url: sideUrl(`/andenchance/${tilbudId}`) },
    // Byderen har ingen handel endnu, så "Mine handler" giver ikke mening.
    sekundaer: undefined,
    aarsag: "Du får denne mail, fordi du har budt på en auktion på BidHamr.",
  });
}

export function saelgerAndenchanceAccepteretMail(titel: string, nyTradeId: string) {
  return handelsMail(`Byderen sagde ja: ${titel}`, {
    preheader: "Køberen har nu 24 timer til at betale.",
    overskriftHtml: "Byderen vil købe varen",
    afsnitHtml: [
      `Byderen har sagt ja til at købe <strong>${escapeHtml(titel)}</strong>.`,
      "Køberen har nu 24 timer til at betale. Vi giver dig besked, når betalingen er modtaget. Send først varen derefter.",
    ],
    knap: { tekst: "Se handlen", url: sideUrl(`/mine-handler/${nyTradeId}`) },
  });
}

export function saelgerAndenchanceAfslaaetMail(
  titel: string,
  tradeId: string,
  aarsag: "afvist" | "udloebet" | "kan_ikke_koebe",
) {
  const overskrift =
    aarsag === "afvist"
      ? "Byderen sagde nej"
      : aarsag === "kan_ikke_koebe"
        ? "Byderen kan ikke købe"
        : "Byderen svarede ikke";
  return handelsMail(`${overskrift}: ${titel}`, {
    preheader: "Send tilbuddet videre eller sæt varen op igen gratis.",
    overskriftHtml: overskrift,
    afsnitHtml: [
      aarsag === "afvist"
        ? `Byderen har sagt nej tak til <strong>${escapeHtml(titel)}</strong>.`
        : aarsag === "kan_ikke_koebe"
          ? `Byderen kan ikke købe <strong>${escapeHtml(titel)}</strong> lige nu, så tilbuddet er lukket.`
          : `Byderen svarede ikke på dit tilbud om <strong>${escapeHtml(titel)}</strong> inden for 24 timer.`,
      "Du kan sende tilbuddet videre til den næste byder i rækken eller sætte varen op igen gratis.",
    ],
    knap: { tekst: "Vælg næste skridt", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

// Fælles mail for notifikationer uden egen skabelon (fx overbudt, ny besked).
// titel og tekst er ren tekst og escapes her.
export function notifikationMail(titel: string, tekst: string, link: string | null) {
  const linjer = tekst
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const foerste = linjer[0] ?? titel;
  return {
    subject: titel,
    ...bygMail({
      preheader: foerste.length > 140 ? `${foerste.slice(0, 137)}...` : foerste,
      overskriftHtml: escapeHtml(titel),
      afsnitHtml: linjer.map(escapeHtml),
      knap: { tekst: "Gå til BidHamr", url: sideUrl(link ?? "/") },
      sekundaer: { tekst: "Se alle notifikationer", url: sideUrl("/notifikationer") },
      aarsag: "Du får denne mail, fordi du har en konto på BidHamr og får besked på mail om denne type hændelse.",
      indstillingsLink: true,
    }),
  };
}

// Erstatter "du vandt"-mailen, når handlen kommer fra et accepteret tilbud.
export function koeberAndenchanceBetalMail(
  titel: string,
  totalOere: number,
  tradeId: string,
  betalSenest: string,
) {
  return handelsMail(`Du har fået varen: ${titel}`, {
    preheader: `Betal ${kronerFraOere(totalOere)} kr senest ${fristTekst(betalSenest)}.`,
    overskriftHtml: "Du har fået varen",
    afsnitHtml: [
      `Du har sagt ja til at købe <strong>${escapeHtml(titel)}</strong>. Du skal betale ${kronerFraOere(totalOere)} kr i alt inkl. købergebyr, fragt og evt. BidHamr Beskyttelse.`,
      `Betal senest <strong>${fristTekst(betalSenest)}</strong>. Du kan betale med kort, MobilePay, Apple Pay eller Google Pay.`,
      STRIPE_KOEBER,
    ],
    info: [
      vare(titel),
      beloeb("At betale i alt", totalOere, true),
      { noegle: "Betal senest", vaerdiHtml: fristTekst(betalSenest) },
    ],
    knap: { tekst: "Betal nu", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

export function koeberAndenchanceAutobetaltMail(titel: string, totalOere: number, tradeId: string) {
  return handelsMail(`Du har fået varen og betalt: ${titel}`, {
    preheader: `${kronerFraOere(totalOere)} kr er trukket på dit gemte kort.`,
    overskriftHtml: "Du har fået varen",
    afsnitHtml: [
      `Du har købt <strong>${escapeHtml(titel)}</strong>, og ${kronerFraOere(totalOere)} kr er trukket automatisk på dit gemte kort.`,
      STRIPE_KOEBER,
    ],
    info: [vare(titel), beloeb("Betalt i alt", totalOere, true)],
    knap: { tekst: "Se handlen", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

// Sælgeren har ikke oprettet en udbetalingskonto, så beløbet kan ikke
// overføres. Sendes ved frigivelse og igen efter 3 og 7 dage.
export function saelgerOpretUdbetalingskontoMail(
  titel: string,
  udbetalingOere: number,
  paamindelse: boolean,
) {
  return handelsMail(
    paamindelse ? "Påmindelse: opret din udbetalingskonto" : `Opret din udbetalingskonto: ${titel}`,
    {
      preheader: `Du skal have ${kronerFraOere(udbetalingOere)} kr. Opret en udbetalingskonto for at få dem.`,
      overskriftHtml: "Opret din udbetalingskonto",
      afsnitHtml: [
        `Handlen om <strong>${escapeHtml(titel)}</strong> er afsluttet, og du skal have ${kronerFraOere(udbetalingOere)} kr.`,
        "Vi kan først sende pengene til dig, når du har oprettet en udbetalingskonto. Det tager et par minutter.",
      ],
      info: [vare(titel), beloeb("Til udbetaling", udbetalingOere, true)],
      knap: { tekst: "Opret udbetalingskonto", url: sideUrl("/konto") },
    },
  );
}

// BidHamr har annulleret en ikke-betalt handel. Ingen advarsel til køberen.
export function koeberAdminAnnulleretMail(titel: string, tradeId: string) {
  return handelsMail(`Handlen er annulleret: ${titel}`, {
    preheader: "BidHamr har annulleret handlen. Du er ikke blevet trukket for noget.",
    overskriftHtml: "Handlen er annulleret",
    afsnitHtml: [
      `Handlen om <strong>${escapeHtml(titel)}</strong> er annulleret af BidHamr. Du er ikke blevet trukket for noget.`,
    ],
    knap: { tekst: "Se handlen", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

export function saelgerAdminAnnulleretMail(titel: string, tradeId: string) {
  return handelsMail(`Handlen er annulleret: ${titel}`, {
    preheader: "BidHamr har annulleret handlen. Du skal ikke sende varen.",
    overskriftHtml: "Handlen er annulleret",
    afsnitHtml: [
      `Handlen om <strong>${escapeHtml(titel)}</strong> er annulleret af BidHamr. Du skal ikke sende varen.`,
      "Du kan tilbyde varen til den næsthøjeste byder til byderens eget højeste bud. Eller du kan sætte varen op igen gratis.",
    ],
    knap: { tekst: "Vælg næste skridt", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}
