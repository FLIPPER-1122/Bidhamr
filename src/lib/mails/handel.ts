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
      overskrift: "Tillykke — du vandt!",
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
      overskrift: "Tillykke — du vandt!",
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
        `Du har vundet <strong>${escapeHtml(titel)}</strong>, men vi har endnu ikke modtaget din betaling på ${kronerFraOere(totalOere)} kr.`,
        `Betal senest <strong>${fristTekst(betalSenest)}</strong>. Betaler du ikke, annulleres handlen, og du får en advarsel.`,
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
