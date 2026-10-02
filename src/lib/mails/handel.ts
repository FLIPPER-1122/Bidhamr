// Mailskabeloner til handelsflowet. Deles af cron-ruten (auktion afsluttet)
// og server actions (pakke sendt), så layoutet kun findes ét sted.

// Mails kan ikke bruge CSS-variabler, så farverne fra DESIGN.md staves ud her.
const GROEN = "#1E5E4A";
const ORANGE = "#B85518"; // 4,83:1 mod hvid tekst (WCAG AA); #E8772E gav kun 2,95:1

export const HANDEL_AFSENDER = "BidHamr <noreply@bidhamr.dk>";

export function sideUrl(sti: string) {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "https://bidhamr.dk";
  return `${base}${sti}`;
}

function skabelon({
  overskrift,
  afsnit,
  knapTekst,
  knapUrl,
  ekstra,
}: {
  overskrift: string;
  afsnit: string[];
  knapTekst: string;
  knapUrl: string;
  ekstra?: string;
}) {
  return `<!DOCTYPE html>
<html lang="da">
  <body style="margin:0;padding:0;background-color:#f5f5f5;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f5f5;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.08);">
            <tr>
              <td align="center" style="background-color:${GROEN};padding:28px 24px;">
                <span style="font-size:24px;font-weight:800;color:#ffffff;letter-spacing:-0.02em;">BidHamr</span>
              </td>
            </tr>
            <tr>
              <td style="padding:36px 32px 28px 32px;">
                <h1 style="margin:0 0 16px 0;font-size:20px;font-weight:700;color:#171717;">${overskrift}</h1>
                ${afsnit
                  .map(
                    (t) =>
                      `<p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:#525252;">${t}</p>`,
                  )
                  .join("")}
                ${ekstra ?? ""}
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:8px;">
                  <tr>
                    <td align="center" style="border-radius:12px;background-color:${ORANGE};">
                      <a href="${knapUrl}" target="_blank" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:12px;">${knapTekst}</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 28px 32px;border-top:1px solid #f0f0f0;">
                <p style="margin:0;font-size:12px;color:#a3a3a3;">
                  BidHamr · <a href="mailto:support@bidhamr.dk" style="color:#a3a3a3;">support@bidhamr.dk</a>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

// Brugerindtastet tekst (fx auktionstitel) må aldrig indsættes rå i HTML.
export function escapeHtml(tekst: string) {
  return tekst
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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

// Vinderen skal selv betale inden for 24 timer.
export function koeberVandtMail(
  titel: string,
  totalOere: number,
  tradeId: string,
  betalSenest: string,
) {
  return {
    subject: `Du vandt auktionen: ${titel}`,
    html: skabelon({
      overskrift: "Tillykke, du vandt",
      afsnit: [
        `Du har vundet auktionen <strong>${escapeHtml(titel)}</strong>. Du skal betale ${kronerFraOere(totalOere)} kr i alt inkl. købergebyr, fragt og evt. BidHamr Beskyttelse.`,
        `Betal senest <strong>${fristTekst(betalSenest)}</strong>. Du kan betale med kort, MobilePay, Apple Pay eller Google Pay, og du kan tilvælge BidHamr Beskyttelse.`,
        "Pengene holdes af Stripe, indtil du har bekræftet, at varen er som den skal være. Først da får sælgeren dem.",
      ],
      knapTekst: "Betal nu",
      knapUrl: sideUrl(`/mine-handler/${tradeId}`),
    }),
  };
}

// Vinderens gemte kort blev trukket automatisk.
export function koeberAutobetaltMail(titel: string, totalOere: number, tradeId: string) {
  return {
    subject: `Du vandt og har betalt: ${titel}`,
    html: skabelon({
      overskrift: "Tillykke, du vandt",
      afsnit: [
        `Du har vundet auktionen <strong>${escapeHtml(titel)}</strong>, og ${kronerFraOere(totalOere)} kr er trukket automatisk på dit gemte kort.`,
        "Pengene holdes af Stripe, indtil du har bekræftet, at varen er som den skal være.",
      ],
      knapTekst: "Se handlen",
      knapUrl: sideUrl(`/mine-handler/${tradeId}`),
    }),
  };
}

export function betalingsPaamindelseMail(
  titel: string,
  totalOere: number,
  tradeId: string,
  betalSenest: string,
) {
  return {
    subject: `Husk at betale: ${titel}`,
    html: skabelon({
      overskrift: "Du mangler at betale",
      afsnit: [
        `Vi har endnu ikke modtaget din betaling på ${kronerFraOere(totalOere)} kr for <strong>${escapeHtml(titel)}</strong>.`,
        `Betal senest <strong>${fristTekst(betalSenest)}</strong>. Ellers bliver handlen annulleret, og du kan få en advarsel.`,
      ],
      knapTekst: "Betal nu",
      knapUrl: sideUrl(`/mine-handler/${tradeId}`),
    }),
  };
}

export function saelgerSolgtMail(titel: string, buddetOere: number, tradeId: string) {
  return {
    subject: `Din auktion er solgt: ${titel}`,
    html: skabelon({
      overskrift: "Din auktion er solgt",
      afsnit: [
        `<strong>${escapeHtml(titel)}</strong> blev solgt for ${kronerFraOere(buddetOere)} kr.`,
        "Køberen har 24 timer til at betale. Vi giver dig besked, så snart betalingen er modtaget — send først varen derefter.",
        "Når køberen har bekræftet varen, overføres beløbet fratrukket 5% sælgergebyr til din udbetalingskonto hos Stripe.",
      ],
      knapTekst: "Se handlen",
      knapUrl: sideUrl(`/mine-handler/${tradeId}`),
    }),
  };
}

export function saelgerBetaltMail(titel: string, tradeId: string) {
  return {
    subject: `Køberen har betalt: ${titel}`,
    html: skabelon({
      overskrift: "Betalingen er modtaget",
      afsnit: [
        `Køberen har betalt for <strong>${escapeHtml(titel)}</strong>.`,
        "Send varen af sted og indtast sporingsnummeret på handelssiden.",
      ],
      knapTekst: "Se handlen",
      knapUrl: sideUrl(`/mine-handler/${tradeId}`),
    }),
  };
}

export function pakkeSendtMail(titel: string, tracking: string, tradeId: string) {
  return {
    subject: `Din pakke er sendt: ${titel}`,
    html: skabelon({
      overskrift: "Pakken er på vej",
      afsnit: [
        `Sælgeren har sendt <strong>${escapeHtml(titel)}</strong>.`,
        "Når pakken er kommet frem, kvitterer du for den på handelssiden. Derefter tjekker du varen og godkender den — først da frigives beløbet til sælgeren.",
      ],
      ekstra: `<p style="margin:0 0 20px 0;padding:12px 16px;background-color:#f5f5f5;border-radius:10px;font-size:14px;color:#171717;">
        Sporingsnummer: <strong>${escapeHtml(tracking)}</strong>
      </p>`,
      knapTekst: "Se handlen",
      knapUrl: sideUrl(`/mine-handler/${tradeId}`),
    }),
  };
}

// --- Vinderen betaler ikke ---------------------------------------------------

// Køberen betalte ikke inden fristen. Advarsel gives ikke automatisk.
export function koeberUbetaltAnnulleretMail(titel: string, tradeId: string) {
  return {
    subject: `Handlen er annulleret: ${titel}`,
    html: skabelon({
      overskrift: "Handlen er annulleret",
      afsnit: [
        `Vi modtog ikke din betaling for <strong>${escapeHtml(titel)}</strong> inden fristen, så handlen er annulleret. Du er ikke blevet trukket for noget.`,
        "Når du byder, lover du at betale, hvis du vinder. En medarbejder ser på sagen, og du kan få en advarsel.",
      ],
      knapTekst: "Se handlen",
      knapUrl: sideUrl(`/mine-handler/${tradeId}`),
    }),
  };
}

export function saelgerUbetaltAnnulleretMail(titel: string, tradeId: string) {
  return {
    subject: `Køberen betalte ikke: ${titel}`,
    html: skabelon({
      overskrift: "Køberen betalte ikke",
      afsnit: [
        `Køberen af <strong>${escapeHtml(titel)}</strong> betalte ikke inden fristen, så handlen er annulleret. Du skal ikke sende varen.`,
        "Du bestemmer selv, hvad der skal ske nu. Du kan tilbyde varen til den næsthøjeste byder til byderens eget højeste bud. Eller du kan sætte varen op igen gratis.",
      ],
      knapTekst: "Vælg næste skridt",
      knapUrl: sideUrl(`/mine-handler/${tradeId}`),
    }),
  };
}

// Næste byder får tilbudt varen til sit eget højeste bud.
export function andenchanceTilbudMail(
  titel: string,
  budOere: number,
  tilbudId: string,
  udloeber: string,
) {
  return {
    subject: `Du kan købe ${titel}`,
    html: skabelon({
      overskrift: "Du får tilbudt varen",
      afsnit: [
        `Auktionen <strong>${escapeHtml(titel)}</strong> blev ikke gennemført. Sælgeren tilbyder dig nu varen til dit eget højeste bud på ${kronerFraOere(budOere)} kr. Dertil kommer købergebyr, fragt og evt. BidHamr Beskyttelse.`,
        `Du har 24 timer til at svare – senest <strong>${fristTekst(udloeber)}</strong>. Siger du ja, har du 24 timer til at betale. Du skylder ikke noget, hvis du siger nej.`,
      ],
      knapTekst: "Se tilbuddet",
      knapUrl: sideUrl(`/andenchance/${tilbudId}`),
    }),
  };
}

export function saelgerAndenchanceAccepteretMail(titel: string, nyTradeId: string) {
  return {
    subject: `Byderen sagde ja: ${titel}`,
    html: skabelon({
      overskrift: "Byderen vil købe varen",
      afsnit: [
        `Byderen har sagt ja til at købe <strong>${escapeHtml(titel)}</strong>.`,
        "Køberen har nu 24 timer til at betale. Vi giver dig besked, når betalingen er modtaget. Send først varen derefter.",
      ],
      knapTekst: "Se handlen",
      knapUrl: sideUrl(`/mine-handler/${nyTradeId}`),
    }),
  };
}

export function saelgerAndenchanceAfslaaetMail(
  titel: string,
  tradeId: string,
  aarsag: "afvist" | "udloebet" | "kan_ikke_koebe",
) {
  return {
    subject:
      aarsag === "afvist"
        ? `Byderen sagde nej: ${titel}`
        : aarsag === "kan_ikke_koebe"
          ? `Byderen kan ikke købe: ${titel}`
          : `Byderen svarede ikke: ${titel}`,
    html: skabelon({
      overskrift:
        aarsag === "afvist"
          ? "Byderen sagde nej"
          : aarsag === "kan_ikke_koebe"
            ? "Byderen kan ikke købe"
            : "Byderen svarede ikke",
      afsnit: [
        aarsag === "afvist"
          ? `Byderen har sagt nej tak til <strong>${escapeHtml(titel)}</strong>.`
          : aarsag === "kan_ikke_koebe"
            ? `Byderen kan ikke købe <strong>${escapeHtml(titel)}</strong> lige nu, så tilbuddet er lukket.`
            : `Byderen svarede ikke på dit tilbud om <strong>${escapeHtml(titel)}</strong> inden for 24 timer.`,
        "Du kan sende tilbuddet videre til den næste byder i rækken eller sætte varen op igen gratis.",
      ],
      knapTekst: "Vælg næste skridt",
      knapUrl: sideUrl(`/mine-handler/${tradeId}`),
    }),
  };
}

// Fælles mail for notifikationer uden egen skabelon (fx overbudt, ny besked).
// titel og tekst er ren tekst og escapes her.
export function notifikationMail(titel: string, tekst: string, link: string | null) {
  return {
    subject: titel,
    html: skabelon({
      overskrift: escapeHtml(titel),
      afsnit: tekst.split("\n").filter(Boolean).map(escapeHtml),
      knapTekst: "Gå til BidHamr",
      knapUrl: sideUrl(link ?? "/"),
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
  return {
    subject: `Du har fået varen: ${titel}`,
    html: skabelon({
      overskrift: "Du har fået varen",
      afsnit: [
        `Du har sagt ja til at købe <strong>${escapeHtml(titel)}</strong>. Du skal betale ${kronerFraOere(totalOere)} kr i alt inkl. købergebyr, fragt og evt. BidHamr Beskyttelse.`,
        `Betal senest <strong>${fristTekst(betalSenest)}</strong>. Du kan betale med kort, MobilePay, Apple Pay eller Google Pay.`,
        "Pengene holdes af Stripe, indtil du har bekræftet, at varen er som den skal være. Først da får sælgeren dem.",
      ],
      knapTekst: "Betal nu",
      knapUrl: sideUrl(`/mine-handler/${tradeId}`),
    }),
  };
}

export function koeberAndenchanceAutobetaltMail(titel: string, totalOere: number, tradeId: string) {
  return {
    subject: `Du har fået varen og betalt: ${titel}`,
    html: skabelon({
      overskrift: "Du har fået varen",
      afsnit: [
        `Du har købt <strong>${escapeHtml(titel)}</strong>, og ${kronerFraOere(totalOere)} kr er trukket automatisk på dit gemte kort.`,
        "Pengene holdes af Stripe, indtil du har bekræftet, at varen er som den skal være.",
      ],
      knapTekst: "Se handlen",
      knapUrl: sideUrl(`/mine-handler/${tradeId}`),
    }),
  };
}

// Sælgeren har ikke oprettet en udbetalingskonto, så beløbet kan ikke
// overføres. Sendes ved frigivelse og igen efter 3 og 7 dage.
export function saelgerOpretUdbetalingskontoMail(
  titel: string,
  udbetalingOere: number,
  paamindelse: boolean,
) {
  return {
    subject: paamindelse
      ? "Påmindelse: opret din udbetalingskonto"
      : `Opret din udbetalingskonto: ${titel}`,
    html: skabelon({
      overskrift: "Opret din udbetalingskonto",
      afsnit: [
        `Handlen om <strong>${escapeHtml(titel)}</strong> er afsluttet, og du skal have ${kronerFraOere(udbetalingOere)} kr.`,
        "Vi kan først sende pengene til dig, når du har oprettet en udbetalingskonto. Det tager et par minutter.",
      ],
      knapTekst: "Opret udbetalingskonto",
      knapUrl: sideUrl("/konto"),
    }),
  };
}

// BidHamr har annulleret en ikke-betalt handel. Ingen advarsel til køberen.
export function koeberAdminAnnulleretMail(titel: string, tradeId: string) {
  return {
    subject: `Handlen er annulleret: ${titel}`,
    html: skabelon({
      overskrift: "Handlen er annulleret",
      afsnit: [
        `Handlen om <strong>${escapeHtml(titel)}</strong> er annulleret af BidHamr. Du er ikke blevet trukket for noget.`,
      ],
      knapTekst: "Se handlen",
      knapUrl: sideUrl(`/mine-handler/${tradeId}`),
    }),
  };
}

export function saelgerAdminAnnulleretMail(titel: string, tradeId: string) {
  return {
    subject: `Handlen er annulleret: ${titel}`,
    html: skabelon({
      overskrift: "Handlen er annulleret",
      afsnit: [
        `Handlen om <strong>${escapeHtml(titel)}</strong> er annulleret af BidHamr. Du skal ikke sende varen.`,
        "Du kan tilbyde varen til den næsthøjeste byder til byderens eget højeste bud. Eller du kan sætte varen op igen gratis.",
      ],
      knapTekst: "Vælg næste skridt",
      knapUrl: sideUrl(`/mine-handler/${tradeId}`),
    }),
  };
}
