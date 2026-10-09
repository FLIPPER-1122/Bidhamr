// Mailskabeloner til handelsflowet. Deles af cron-ruten (auktion afsluttet)
// og server actions (pakke sendt). Selve layoutet ligger i ./layout, så alle
// mails ser ens ud.
import { bygMail, escapeHtml, sideUrl, type InfoRaekke, type MailLayoutInput } from "./layout";
import {
  KVITTERING_IKKE_FAKTURA,
  KVITTERING_STRIPE,
  kvitteringDato,
  kvitteringLinjer,
  type KoeberKvittering,
  type Kvittering,
  type SaelgerKvittering,
} from "@/lib/kvittering";
import { FAKTURA_TEKST } from "@/lib/faktura/tekster";

export { escapeHtml, sideUrl };

export const HANDEL_AFSENDER = "BidHamr <noreply@bidhamr.dk>";

const AARSAG_HANDEL = "Du får denne mail, fordi du er køber eller sælger i en handel på BidHamr.";
const MINE_HANDLER = { tekst: "Se alle dine handler", url: sideUrl("/mine-handler") };
const STRIPE_KOEBER =
  "Betalingen håndteres af vores betalingspartner Stripe. Sælgeren får først pengene, når du har godkendt varen, eller når fristen for at oprette en sag er gået.";

// Link til BidHamrs faktura på gebyrerne (src/lib/faktura - laves i Dinero
// få minutter efter betalingen).
const FAKTURA_AFSNIT = `${escapeHtml(FAKTURA_TEKST.mailLinkTekst)} <a href="${sideUrl("/konto/fakturaer")}">Se dine fakturaer</a>.`;

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

// Vinderen skal selv betale inden for 48 timer.
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
      `Du har vundet auktionen <strong>${escapeHtml(titel)}</strong>. Beløbet nedenfor er inkl. købergebyr, eventuel fragt og BidHamr Beskyttelse, hvis du valgte den.`,
      "Gå til betalingssiden inden for 48 timer. Skal varen sendes, vælger du levering der – til en pakkeshop eller hjem, hvis pakken kan det. Prisen kan ændre sig lidt efter dit valg, og du ser den samlede pris, før du betaler. Du kan betale med fx kort, MobilePay, Apple Pay eller Google Pay.",
      "Betaler du ikke til tiden, bliver handlen annulleret.",
      STRIPE_KOEBER,
    ],
    info: [
      vare(titel),
      beloeb("At betale i alt", totalOere, true),
      { noegle: "Betal senest", vaerdiHtml: fristTekst(betalSenest) },
    ],
    knap: { tekst: "Gå til betaling", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

// Vinderen har allerede betalt på checkout-siden, før "du vandt" blev sendt.
// (Ingen automatisk betaling - Filip, 9. okt. 2026.)
export function koeberVandtBetaltMail(titel: string, totalOere: number, tradeId: string) {
  return handelsMail(`Du vandt og har betalt: ${titel}`, {
    preheader: `Din betaling på ${kronerFraOere(totalOere)} kr er gennemført. Sælgeren har fået besked.`,
    overskriftHtml: "Tillykke, du vandt",
    afsnitHtml: [
      `Du har vundet auktionen <strong>${escapeHtml(titel)}</strong>. Din betaling er gennemført, og sælgeren har fået besked.`,
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
    preheader: `Betal senest ${fristTekst(betalSenest)}, ellers bliver handlen annulleret.`,
    overskriftHtml: "Du mangler at betale",
    afsnitHtml: [
      `Du har endnu ikke betalt for <strong>${escapeHtml(titel)}</strong>.`,
      "Betaler du ikke inden fristen, bliver handlen annulleret, og du kan få en advarsel.",
    ],
    info: [
      vare(titel),
      beloeb("At betale i alt", totalOere, true),
      { noegle: "Betal senest", vaerdiHtml: fristTekst(betalSenest) },
    ],
    knap: { tekst: "Betal nu", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

// Sælgeren har forlænget betalingsfristen (handel_forlaeng_betalingsfrist).
export function betalingsfristForlaengetMail(
  titel: string,
  totalOere: number,
  tradeId: string,
  betalSenest: string,
) {
  return handelsMail(`Ny betalingsfrist: ${titel}`, {
    preheader: `Sælgeren har forlænget fristen. Betal senest ${fristTekst(betalSenest)}.`,
    overskriftHtml: "Du har fået længere tid til at betale",
    afsnitHtml: [
      `Sælgeren har forlænget fristen for at betale for <strong>${escapeHtml(titel)}</strong>.`,
      "Betaler du ikke inden den nye frist, bliver handlen annulleret.",
      STRIPE_KOEBER,
    ],
    info: [
      vare(titel),
      beloeb("At betale i alt", totalOere, true),
      { noegle: "Ny frist", vaerdiHtml: fristTekst(betalSenest) },
    ],
    knap: { tekst: "Betal nu", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

export function saelgerSolgtMail(titel: string, buddetOere: number, tradeId: string) {
  return handelsMail(`Din auktion er solgt: ${titel}`, {
    preheader: `Solgt for ${kronerFraOere(buddetOere)} kr. Vent med at sende varen, til køberen har betalt.`,
    overskriftHtml: "Din auktion er solgt",
    afsnitHtml: [
      `<strong>${escapeHtml(titel)}</strong> er solgt.`,
      "Køberen har 48 timer til at betale. Vent med at sende varen, til vi giver dig besked om, at køberen har betalt.",
      "Du får pengene, når køberen har bekræftet at have modtaget varen, eller når fristen for at oprette en sag er udløbet. Udbetalingen er salgsprisen minus 5 % i sælgergebyr. Betalingen håndteres af vores betalingspartner Stripe.",
    ],
    info: [vare(titel), beloeb("Solgt for", buddetOere, true)],
    knap: { tekst: "Se handlen", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

export function saelgerBetaltMail(titel: string, tradeId: string) {
  return handelsMail(`Køberen har betalt: ${titel}`, {
    preheader: "Send varen, og indtast sporingsnummeret på handelssiden.",
    overskriftHtml: "Køberen har betalt",
    afsnitHtml: [
      `Køberen har betalt for <strong>${escapeHtml(titel)}</strong>. Send varen, og indtast sporingsnummeret på handelssiden.`,
      "Pak varen godt ind, så den ikke går i stykker undervejs.",
    ],
    knap: { tekst: "Se handlen", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

// Kun afhentning: sælgeren sender ikke noget, men aftaler afhentning.
export function saelgerBetaltAfhentningMail(titel: string, tradeId: string) {
  return handelsMail(`Køberen har betalt: ${titel}`, {
    preheader: "Aftal afhentning med køberen i handelschatten.",
    overskriftHtml: "Køberen har betalt",
    afsnitHtml: [
      `Køberen har betalt for <strong>${escapeHtml(titel)}</strong>. Aftal tid og sted for afhentningen med køberen i chatten på handelssiden.`,
      "Når køberen henter varen, viser køberen dig en kode på 6 cifre. Tast koden ind på handelssiden, så får du pengene udbetalt med det samme.",
      "<strong>Giv ikke varen fra dig, før du har tastet den rigtige kode ind.</strong>",
    ],
    knap: { tekst: "Se handlen", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

// Kun afhentning: køberen henter varen og viser sin kode. Med kvittering
// (beløbene opdelt), når den kunne hentes.
export function koeberAfhentningMail(
  titel: string,
  tradeId: string,
  kvittering: KoeberKvittering | null = null,
) {
  return handelsMail(`Aftal afhentning: ${titel}`, {
    preheader: "Aftal afhentning med sælgeren – vis koden ved afhentning.",
    overskriftHtml: "Aftal afhentning med sælgeren",
    afsnitHtml: [
      `Din betaling for <strong>${escapeHtml(titel)}</strong> er gennemført. Aftal tid og sted for afhentningen med sælgeren i chatten på handelssiden.`,
      "Din afhentningskode finder du på handelssiden. Du får den, når du har givet sælgeren 1-5 stjerner. Vis koden til sælgeren, når du henter varen.",
      "Tjek varen, før du viser koden. Når sælgeren har tastet koden ind, får sælgeren pengene med det samme, og du kan ikke klage over handlen bagefter.",
      "<strong>Vis kun koden, når du står med varen i hånden. Send den aldrig i chatten.</strong>",
      ...(kvittering
        ? [
            "Herunder er din kvittering for købet.",
            `${escapeHtml(KVITTERING_IKKE_FAKTURA)} ${escapeHtml(KVITTERING_STRIPE)}`,
            FAKTURA_AFSNIT,
          ]
        : []),
    ],
    info: kvittering ? kvitteringInfo(kvittering) : undefined,
    knap: { tekst: "Se handlen", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

// --- Kvittering og afregning ---------------------------------------------------

// Fælles infoboks: vare, modpart, dato, handels-id og beløbene opdelt
// (samme opdeling som på handelssiden).
function kvitteringInfo(k: Kvittering): InfoRaekke[] {
  return [
    vare(k.titel),
    {
      noegle: k.rolle === "koeber" ? "Sælger" : "Køber",
      vaerdiHtml: escapeHtml(k.modpartNavn),
    },
    {
      noegle: k.rolle === "koeber" ? "Betalt" : "Afsluttet",
      vaerdiHtml: escapeHtml(kvitteringDato(k.dato)),
    },
    { noegle: "Handels-id", vaerdiHtml: escapeHtml(k.handelId) },
    ...kvitteringLinjer(k).map((l) => ({
      noegle: l.tekst,
      vaerdiHtml: `${l.fratraek ? "−&nbsp;" : ""}${kronerFraOere(l.oere)}&nbsp;kr`,
      fremhaev: l.fremhaev,
    })),
  ];
}

// Køberen har betalt (forsendelse). Afhentning får kvitteringen i
// koeberAfhentningMail i stedet.
export function koeberKvitteringMail(k: KoeberKvittering) {
  return handelsMail(`Kvittering for dit køb: ${k.titel}`, {
    preheader: `Du har betalt ${kronerFraOere(k.totalOere)} kr. Sælgeren får besked om at sende varen.`,
    overskriftHtml: "Kvittering for dit køb",
    afsnitHtml: [
      `Tak for din betaling for <strong>${escapeHtml(k.titel)}</strong>. Sælgeren får besked om at sende varen, og du får besked, når pakken er på vej.`,
      STRIPE_KOEBER,
      escapeHtml(KVITTERING_IKKE_FAKTURA),
      FAKTURA_AFSNIT,
    ],
    info: kvitteringInfo(k),
    knap: { tekst: "Se handlen", url: sideUrl(`/mine-handler/${k.handelId}`) },
  });
}

// Handlen er afsluttet, og pengene er frigivet til sælgeren. overskrift og
// indledning er ren tekst og escapes her.
export function saelgerAfregningMail(
  k: SaelgerKvittering,
  overskrift: string,
  indledning: string,
) {
  return handelsMail(`${overskrift}: ${k.titel}`, {
    preheader: `Pengene for ${k.titel} er frigivet. Udbetalingen sendes til din udbetalingskonto hos Stripe.`,
    overskriftHtml: escapeHtml(overskrift),
    afsnitHtml: [
      escapeHtml(indledning),
      `Pengene er frigivet. Udbetalingen på ${escapeHtml(kronerFraOere(k.udbetalingOere))} kr sendes til din udbetalingskonto hos vores betalingspartner Stripe. Udbetalingen er salgsprisen minus 5 % i sælgergebyr.${
        k.afhentning ? "" : " Fragten betaler køberen, og den går til fragtfirmaet – den indgår ikke i din udbetaling."
      }`,
      escapeHtml(KVITTERING_IKKE_FAKTURA),
      FAKTURA_AFSNIT,
    ],
    info: kvitteringInfo(k),
    knap: { tekst: "Se handlen", url: sideUrl(`/mine-handler/${k.handelId}`) },
  });
}

export function pakkeSendtMail(titel: string, tracking: string, tradeId: string) {
  return handelsMail(`Din pakke er på vej: ${titel}`, {
    preheader: `Sporingsnummer: ${tracking}`,
    overskriftHtml: "Pakken er på vej",
    afsnitHtml: [
      `Sælgeren har sendt <strong>${escapeHtml(titel)}</strong>. Du kan følge pakken med sporingsnummeret nedenfor.`,
      "Når pakken er kommet frem, kvitterer du for den på handelssiden. Tjek varen, og godkend den. Sælgeren får pengene, når du har godkendt varen, eller automatisk efter 48 timer, hvis du ikke har oprettet en sag.",
    ],
    info: [vare(titel), { noegle: "Sporingsnummer", vaerdiHtml: escapeHtml(tracking) }],
    knap: { tekst: "Se handlen", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

// --- Vinderen betaler ikke ---------------------------------------------------

// Køberen betalte ikke inden fristen. Advarsel gives ikke automatisk.
export function koeberUbetaltAnnulleretMail(titel: string, tradeId: string) {
  return handelsMail(`Handlen er annulleret: ${titel}`, {
    preheader: "Du betalte ikke inden fristen. Du er ikke blevet opkrævet noget.",
    overskriftHtml: "Handlen er annulleret",
    afsnitHtml: [
      `Du betalte ikke for <strong>${escapeHtml(titel)}</strong> inden fristen, så handlen er annulleret. Du er ikke blevet opkrævet noget.`,
      "Når du byder, forpligter du dig til at betale, hvis du vinder. En medarbejder ser nu på sagen, og du kan få en advarsel.",
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
      "Du bestemmer selv, hvad der skal ske nu. Du kan tilbyde varen til den næsthøjeste byder til byderens eget højeste bud, eller du kan sætte varen op igen gratis.",
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
  return handelsMail(`Du får tilbudt varen: ${titel}`, {
    preheader: `Køb varen til dit eget højeste bud. Svar senest ${fristTekst(udloeber)}.`,
    overskriftHtml: "Du får tilbudt varen",
    afsnitHtml: [
      `Handlen om <strong>${escapeHtml(titel)}</strong> blev ikke gennemført, og sælgeren tilbyder dig nu varen til dit eget højeste bud. Dertil kommer købergebyr, fragt og evt. BidHamr Beskyttelse.`,
      "Du har 24 timer til at svare. Siger du ja, har du 48 timer til at betale. Siger du nej, koster det dig ingenting.",
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
    preheader: "Køberen har nu 48 timer til at betale. Vent med at sende varen.",
    overskriftHtml: "Byderen vil købe varen",
    afsnitHtml: [
      `Byderen har sagt ja til at købe <strong>${escapeHtml(titel)}</strong>.`,
      "Køberen har nu 48 timer til at betale. Vent med at sende varen, til vi giver dig besked om, at køberen har betalt.",
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
    preheader: "Send tilbuddet videre, eller sæt varen op igen gratis.",
    overskriftHtml: overskrift,
    afsnitHtml: [
      aarsag === "afvist"
        ? `Byderen har sagt nej tak til <strong>${escapeHtml(titel)}</strong>.`
        : aarsag === "kan_ikke_koebe"
          ? `Byderen kan ikke købe <strong>${escapeHtml(titel)}</strong>, så tilbuddet er lukket.`
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
      knap: { tekst: "Se på BidHamr", url: sideUrl(link ?? "/") },
      sekundaer: { tekst: "Se alle notifikationer", url: sideUrl("/notifikationer") },
      aarsag: "Du får denne mail, fordi du har en konto på BidHamr og har slået mail til for denne type besked.",
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
  return handelsMail(`Betal for din vare: ${titel}`, {
    preheader: `Betal ${kronerFraOere(totalOere)} kr senest ${fristTekst(betalSenest)}.`,
    overskriftHtml: "Betal for din vare",
    afsnitHtml: [
      `Du har sagt ja til at købe <strong>${escapeHtml(titel)}</strong>. Beløbet nedenfor er inkl. købergebyr og fragt samt BidHamr Beskyttelse, hvis du valgte den.`,
      "Betal inden for 48 timer, fx med kort, MobilePay, Apple Pay eller Google Pay. Betaler du ikke til tiden, bliver handlen annulleret.",
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

// Køberen har allerede betalt på checkout-siden (handel fra et tilbud).
export function koeberAndenchanceBetaltMail(titel: string, totalOere: number, tradeId: string) {
  return handelsMail(`Du har købt og betalt: ${titel}`, {
    preheader: `Din betaling på ${kronerFraOere(totalOere)} kr er gennemført. Sælgeren har fået besked.`,
    overskriftHtml: "Du har købt varen",
    afsnitHtml: [
      `Du har købt <strong>${escapeHtml(titel)}</strong>. Din betaling er gennemført, og sælgeren har fået besked.`,
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
      preheader: `Du skal have ${kronerFraOere(udbetalingOere)} kr udbetalt. Opret en udbetalingskonto for at få dem.`,
      overskriftHtml: "Opret din udbetalingskonto",
      afsnitHtml: [
        `Handlen om <strong>${escapeHtml(titel)}</strong> er afsluttet.`,
        "Pengene kan først udbetales, når du har oprettet en udbetalingskonto hos vores betalingspartner Stripe. Det tager kun et par minutter.",
      ],
      info: [vare(titel), beloeb("Til udbetaling", udbetalingOere, true)],
      knap: { tekst: "Opret udbetalingskonto", url: sideUrl("/konto") },
    },
  );
}

// BidHamr har annulleret en ikke-betalt handel. Ingen advarsel til køberen.
export function koeberAdminAnnulleretMail(titel: string, tradeId: string) {
  return handelsMail(`Handlen er annulleret: ${titel}`, {
    preheader: "BidHamr har annulleret handlen. Du er ikke blevet opkrævet noget.",
    overskriftHtml: "Handlen er annulleret",
    afsnitHtml: [
      `BidHamr har annulleret handlen om <strong>${escapeHtml(titel)}</strong>. Du er ikke blevet opkrævet noget.`,
    ],
    knap: { tekst: "Se handlen", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

export function saelgerAdminAnnulleretMail(titel: string, tradeId: string) {
  return handelsMail(`Handlen er annulleret: ${titel}`, {
    preheader: "BidHamr har annulleret handlen. Du skal ikke sende varen.",
    overskriftHtml: "Handlen er annulleret",
    afsnitHtml: [
      `BidHamr har annulleret handlen om <strong>${escapeHtml(titel)}</strong>. Du skal ikke sende varen.`,
      "Du kan tilbyde varen til den næsthøjeste byder til byderens eget højeste bud, eller du kan sætte varen op igen gratis.",
    ],
    knap: { tekst: "Vælg næste skridt", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

// --- Afsendelsesfrist (5 dage efter betalingen) ------------------------------

// Påmindelse til sælgeren efter dag 3 og dag 4. sendSenestTekst er allerede
// formateret (fx "mandag 6. oktober kl. 14.30").
export function saelgerAfsendelsesPaamindelseMail(
  titel: string,
  tradeId: string,
  sendSenestTekst: string,
) {
  return handelsMail(`Husk at sende pakken: ${titel}`, {
    preheader: `Send pakken senest ${sendSenestTekst}, ellers annulleres handlen.`,
    overskriftHtml: "Husk at sende pakken",
    afsnitHtml: [
      `Køberen har betalt for <strong>${escapeHtml(titel)}</strong>, men pakken er endnu ikke markeret som sendt.`,
      `Send pakken senest <strong>${escapeHtml(sendSenestTekst)}</strong>, ellers annulleres handlen, og køberen får hele beløbet tilbage.`,
      "Tag billederne af indpakningen, og indtast sporingsnummeret på handelssiden, når du har sendt varen.",
    ],
    info: [vare(titel), { noegle: "Send senest", vaerdiHtml: escapeHtml(sendSenestTekst) }],
    knap: { tekst: "Send pakken", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

// Køberen: sælgeren sendte ikke i tide, fuld refusion via Stripe.
export function koeberAfsendelsesfristAnnulleretMail(
  titel: string,
  totalOere: number,
  tradeId: string,
) {
  return handelsMail(`Handlen er annulleret: ${titel}`, {
    preheader: "Sælgeren sendte ikke varen i tide. Du får hele beløbet tilbage.",
    overskriftHtml: "Handlen er annulleret",
    afsnitHtml: [
      `Sælgeren sendte ikke <strong>${escapeHtml(titel)}</strong> i tide, så handlen er annulleret. Du får hele beløbet tilbage.`,
      "Pengene sendes tilbage til den betalingsmetode, du betalte med. Der kan gå nogle dage, før de står på din konto. Betalingen håndteres af vores betalingspartner Stripe.",
    ],
    info: [vare(titel), beloeb("Du får tilbage", totalOere, true)],
    knap: { tekst: "Se handlen", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

// Sælgeren: handlen er annulleret, fordi pakken ikke blev markeret sendt.
export function saelgerAfsendelsesfristAnnulleretMail(titel: string, tradeId: string) {
  return handelsMail(`Handlen er annulleret: ${titel}`, {
    preheader: "Pakken blev ikke sendt inden 5 dage. Du skal ikke sende varen.",
    overskriftHtml: "Handlen er annulleret",
    afsnitHtml: [
      `Pakken med <strong>${escapeHtml(titel)}</strong> blev ikke markeret som sendt inden 5 dage efter betalingen, så handlen er annulleret, og køberen får hele beløbet tilbage.`,
      "Du skal ikke sende varen. Har du allerede sendt den, så skriv straks til support@bidhamr.dk med sporingsnummeret.",
    ],
    knap: { tekst: "Se handlen", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

// --- Afhentningsfrist (7 dage efter betalingen) ------------------------------

// Påmindelse 2 døgn før afhentningsfristen (dag 5) til køber og sælger.
// fristTekst er allerede formateret (fx "mandag 6. oktober kl. 14.30").
export function afhentningPaamindelseMail(
  rolle: "koeber" | "saelger",
  titel: string,
  tradeId: string,
  fristTekst: string,
) {
  const koeber = rolle === "koeber";
  return handelsMail(`Husk afhentningen: ${titel}`, {
    preheader: `Varen skal hentes senest ${fristTekst}.`,
    overskriftHtml: koeber ? "Husk at hente varen" : "Varen er ikke hentet endnu",
    afsnitHtml: koeber
      ? [
          `Du har betalt for <strong>${escapeHtml(titel)}</strong>, men varen er ikke hentet endnu.`,
          `Hent varen senest <strong>${escapeHtml(fristTekst)}</strong>. Aftal tid og sted med sælgeren i chatten på handelssiden, og vis din afhentningskode, når du står med varen.`,
          "Kan du ikke nå det, så skriv til sælgeren i chatten. Sælgeren kan give dig mere tid.",
        ]
      : [
          `Køberen har betalt for <strong>${escapeHtml(titel)}</strong>, men varen er ikke hentet endnu.`,
          `Varen skal hentes senest <strong>${escapeHtml(fristTekst)}</strong>. Aftal tid og sted med køberen i chatten på handelssiden, og tast køberens kode ind, når varen er hentet.`,
          "Har I aftalt en senere dag, kan du forlænge fristen på handelssiden.",
        ],
    info: [vare(titel), { noegle: "Hentes senest", vaerdiHtml: escapeHtml(fristTekst) }],
    knap: { tekst: "Se handlen", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

// Sælgeren har forlænget afhentningsfristen (afhentning_forlaeng_frist).
export function afhentningsfristForlaengetMail(titel: string, tradeId: string, fristTekst: string) {
  return handelsMail(`Ny afhentningsfrist: ${titel}`, {
    preheader: `Sælgeren har givet dig mere tid. Hent varen senest ${fristTekst}.`,
    overskriftHtml: "Du har fået mere tid til at hente varen",
    afsnitHtml: [
      `Sælgeren har forlænget fristen for at hente <strong>${escapeHtml(titel)}</strong>.`,
      `Hent varen senest <strong>${escapeHtml(fristTekst)}</strong>, og vis din afhentningskode, når du står med varen.`,
    ],
    info: [vare(titel), { noegle: "Ny frist", vaerdiHtml: escapeHtml(fristTekst) }],
    knap: { tekst: "Se handlen", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

// Køberen: varen blev ikke hentet, og handlen blev ikke afgjort af BidHamr.
// Alle pengene sendes tilbage via Stripe.
export function koeberAfhentningAnnulleretMail(titel: string, totalOere: number, tradeId: string) {
  return handelsMail(`Handlen er annulleret: ${titel}`, {
    preheader: "Varen blev ikke hentet, og du får alle pengene tilbage.",
    overskriftHtml: "Du får alle pengene tilbage",
    afsnitHtml: [
      `Handlen om <strong>${escapeHtml(titel)}</strong> er annulleret. Varen blev ikke hentet, og du får alle pengene tilbage.`,
      "Pengene sendes tilbage til den betalingsmetode, du betalte med. Der kan gå nogle dage, før de står på din konto. Betalingen håndteres af vores betalingspartner Stripe.",
    ],
    info: [vare(titel), beloeb("Du får tilbage", totalOere, true)],
    knap: { tekst: "Se handlen", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

// Sælgeren: handlen er annulleret, fordi varen ikke blev hentet.
export function saelgerAfhentningAnnulleretMail(titel: string, tradeId: string) {
  return handelsMail(`Handlen er annulleret: ${titel}`, {
    preheader: "Varen blev ikke hentet. Du beholder varen.",
    overskriftHtml: "Handlen er annulleret",
    afsnitHtml: [
      `Handlen om <strong>${escapeHtml(titel)}</strong> er annulleret, fordi varen ikke blev hentet. Du beholder varen.`,
      "Køberen får sine penge tilbage. Har køberen alligevel hentet varen, så skriv straks til support@bidhamr.dk.",
    ],
    knap: { tekst: "Se handlen", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

// ---------------------------------------------------------------- betalingen venter på sælgerens konto
// Betalingsmodel destination (trin 2): sælgerens Stripe-konto er ikke
// godkendt endnu, når auktionen slutter. Betalingen (og 48-timersfristen)
// starter først, når kontoen er godkendt.

// Vinderen: betalingen åbner senere.
export function koeberVandtVenterMail(titel: string, totalOere: number, tradeId: string) {
  return handelsMail(`Du vandt auktionen: ${titel}`, {
    preheader: "Du kan betale, så snart sælgerens konto er godkendt. Vi giver dig besked.",
    overskriftHtml: "Tillykke, du vandt",
    afsnitHtml: [
      `Du har vundet auktionen <strong>${escapeHtml(titel)}</strong>.`,
      "Sælgerens konto hos vores betalingspartner Stripe er ikke godkendt endnu, så du kan ikke betale lige nu. Vi giver dig besked, så snart du kan betale – derefter har du 48 timer.",
      "Bliver sælgerens konto ikke godkendt inden for 7 dage, bliver handlen annulleret, og du bliver ikke trukket noget.",
    ],
    info: [vare(titel), beloeb("At betale i alt", totalOere, true)],
    knap: { tekst: "Se handlen", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

// Vinderen: nu kan der betales.
export function koeberBetalingAabnetMail(
  titel: string,
  totalOere: number,
  tradeId: string,
  betalSenest: string,
) {
  return handelsMail(`Nu kan du betale: ${titel}`, {
    preheader: `Betal ${kronerFraOere(totalOere)} kr senest ${fristTekst(betalSenest)}.`,
    overskriftHtml: "Nu kan du betale",
    afsnitHtml: [
      `Sælgerens konto er godkendt, og du kan nu betale for <strong>${escapeHtml(titel)}</strong>.`,
      "Betal inden for 48 timer, fx med kort, MobilePay, Apple Pay eller Google Pay. Betaler du ikke til tiden, bliver handlen annulleret.",
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

// Sælgeren: auktionen er solgt, men kontoen kan ikke tage imod betalingen.
export function saelgerKontoIkkeKlarMail(titel: string, paamindelse: boolean) {
  return handelsMail(
    paamindelse ? `Påmindelse: din konto er ikke godkendt – ${titel}` : `Din auktion er solgt: ${titel}`,
    {
      preheader: "Køberen kan først betale, når din konto hos Stripe er godkendt.",
      overskriftHtml: paamindelse ? "Din konto er stadig ikke godkendt" : "Din auktion er solgt",
      afsnitHtml: [
        `<strong>${escapeHtml(titel)}</strong> er solgt, men din konto hos vores betalingspartner Stripe er ikke godkendt endnu. Køberen kan først betale, når den er godkendt.`,
        "Gør opsætningen færdig under Min konto. Er kontoen ikke godkendt senest 7 dage efter, at auktionen sluttede, bliver handlen annulleret, og du kan ikke sætte varer til salg, før Stripe har godkendt kontoen.",
        "Send eller udlevér ikke varen, før køberen har betalt.",
      ],
      info: [vare(titel)],
      knap: { tekst: "Gør kontoen færdig", url: sideUrl("/konto") },
    },
  );
}

// En åben betaling er sat på pause: sælgerens konto kan ikke tage imod
// betaling lige nu. Fristen er mindst 48 timer.
export function koeberBetalingPauseMail(titel: string, tradeId: string, frist: string) {
  return handelsMail(`Betalingen er sat på pause: ${titel}`, {
    preheader: `Du kan ikke betale lige nu. Vi giver dig besked, når du kan.`,
    overskriftHtml: "Betalingen er sat på pause",
    afsnitHtml: [
      `Sælgerens konto hos vores betalingspartner Stripe kan ikke tage imod betaling lige nu, så du kan ikke betale for <strong>${escapeHtml(titel)}</strong> endnu.`,
      "Vi giver dig besked, så snart du kan betale – derefter har du 48 timer.",
      `Er sælgerens konto ikke klar senest ${fristTekst(frist)}, bliver handlen annulleret, og du bliver ikke trukket noget.`,
    ],
    info: [vare(titel), { noegle: "Sælgerens frist", vaerdiHtml: fristTekst(frist) }],
    knap: { tekst: "Se handlen", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

export function saelgerBetalingPauseMail(titel: string, frist: string) {
  return handelsMail(`Køberen kan ikke betale: ${titel}`, {
    preheader: `Din konto hos Stripe kan ikke tage imod betaling. Ret det senest ${fristTekst(frist)}.`,
    overskriftHtml: "Din konto kan ikke tage imod betaling",
    afsnitHtml: [
      `Køberen kan ikke betale for <strong>${escapeHtml(titel)}</strong>, fordi din konto hos vores betalingspartner Stripe ikke kan tage imod betaling lige nu.`,
      `Ret det under Min konto senest ${fristTekst(frist)}. Ellers bliver handlen annulleret, og du kan ikke sætte varer til salg, før Stripe har godkendt kontoen.`,
      "Send eller udlevér ikke varen, før køberen har betalt.",
    ],
    info: [vare(titel), { noegle: "Frist", vaerdiHtml: fristTekst(frist) }],
    knap: { tekst: "Gør kontoen færdig", url: sideUrl("/konto") },
  });
}

// Handlen er annulleret, fordi sælgerens konto ikke blev godkendt.
export function koeberAnnulleretSaelgerkontoMail(titel: string, tradeId: string) {
  return handelsMail(`Handlen er annulleret: ${titel}`, {
    preheader: "Sælgerens konto blev ikke godkendt. Du er ikke blevet trukket noget.",
    overskriftHtml: "Handlen er annulleret",
    afsnitHtml: [
      `Handlen om <strong>${escapeHtml(titel)}</strong> er annulleret, fordi sælgerens konto hos vores betalingspartner Stripe ikke blev godkendt i tide.`,
      "Du er ikke blevet trukket noget, og du får ingen advarsel.",
    ],
    knap: { tekst: "Se handlen", url: sideUrl(`/mine-handler/${tradeId}`) },
  });
}

export function saelgerAnnulleretSaelgerkontoMail(titel: string) {
  return handelsMail(`Din auktion er annulleret: ${titel}`, {
    preheader: "Din konto hos Stripe blev ikke godkendt inden for 7 dage.",
    overskriftHtml: "Din auktion er annulleret",
    afsnitHtml: [
      `Auktionen <strong>${escapeHtml(titel)}</strong> er annulleret, fordi din konto hos vores betalingspartner Stripe ikke blev godkendt inden for 7 dage efter, at auktionen sluttede. Køberen er ikke blevet trukket noget.`,
      "Din konto er sat på pause: du kan ikke sætte varer til salg, og der kan ikke bydes på dine auktioner, før Stripe har godkendt din konto. Gør opsætningen færdig under Min konto.",
    ],
    knap: { tekst: "Gør kontoen færdig", url: sideUrl("/konto") },
  });
}
