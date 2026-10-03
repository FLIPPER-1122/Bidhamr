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

export { escapeHtml, sideUrl };

export const HANDEL_AFSENDER = "BidHamr <noreply@bidhamr.dk>";

const AARSAG_HANDEL = "Du får denne mail, fordi du er køber eller sælger i en handel på BidHamr.";
const MINE_HANDLER = { tekst: "Se alle dine handler", url: sideUrl("/mine-handler") };
const STRIPE_KOEBER =
  "Betalingen håndteres af vores betalingspartner Stripe. Sælgeren får først pengene, når du har bekræftet, at du har modtaget varen, og at den er som beskrevet.";

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
      `Du har vundet auktionen <strong>${escapeHtml(titel)}</strong>. Beløbet nedenfor er inkl. købergebyr og fragt samt BidHamr Beskyttelse, hvis du valgte den.`,
      "Betal inden for 24 timer, fx med kort, MobilePay, Apple Pay eller Google Pay. Betaler du ikke til tiden, bliver handlen annulleret.",
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
    preheader: `${kronerFraOere(totalOere)} kr er trukket på dit gemte kort. Sælgeren får besked om at sende varen.`,
    overskriftHtml: "Tillykke, du vandt",
    afsnitHtml: [
      `Du har vundet auktionen <strong>${escapeHtml(titel)}</strong>. Beløbet er trukket automatisk på dit gemte kort, og sælgeren får besked om at sende varen.`,
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

export function saelgerSolgtMail(titel: string, buddetOere: number, tradeId: string) {
  return handelsMail(`Din auktion er solgt: ${titel}`, {
    preheader: `Solgt for ${kronerFraOere(buddetOere)} kr. Vent med at sende varen, til køberen har betalt.`,
    overskriftHtml: "Din auktion er solgt",
    afsnitHtml: [
      `<strong>${escapeHtml(titel)}</strong> er solgt.`,
      "Køberen har 24 timer til at betale. Vent med at sende varen, til vi giver dig besked om, at køberen har betalt.",
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
      "Du har 24 timer til at svare. Siger du ja, har du 24 timer til at betale. Siger du nej, koster det dig ingenting.",
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
    preheader: "Køberen har nu 24 timer til at betale. Vent med at sende varen.",
    overskriftHtml: "Byderen vil købe varen",
    afsnitHtml: [
      `Byderen har sagt ja til at købe <strong>${escapeHtml(titel)}</strong>.`,
      "Køberen har nu 24 timer til at betale. Vent med at sende varen, til vi giver dig besked om, at køberen har betalt.",
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
      "Betal inden for 24 timer, fx med kort, MobilePay, Apple Pay eller Google Pay. Betaler du ikke til tiden, bliver handlen annulleret.",
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
  return handelsMail(`Du har købt og betalt: ${titel}`, {
    preheader: `${kronerFraOere(totalOere)} kr er trukket på dit gemte kort. Sælgeren får besked om at sende varen.`,
    overskriftHtml: "Du har købt varen",
    afsnitHtml: [
      `Du har købt <strong>${escapeHtml(titel)}</strong>. Beløbet er trukket automatisk på dit gemte kort, og sælgeren får besked om at sende varen.`,
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
