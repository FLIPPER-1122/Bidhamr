// Mailskabeloner til handelsflowet. Deles af cron-ruten (auktion afsluttet)
// og server actions (pakke sendt), så layoutet kun findes ét sted.

const BRAND = "#E63946";

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
              <td align="center" style="background-color:${BRAND};padding:28px 24px;">
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
                    <td align="center" style="border-radius:12px;background-color:${BRAND};">
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

export function koeberVandtMail(titel: string, beloeb: number, tradeId: string) {
  return {
    subject: `Du vandt auktionen: ${titel}`,
    html: skabelon({
      overskrift: "Tillykke — du vandt!",
      afsnit: [
        `Du har vundet auktionen <strong>${titel}</strong> til ${beloeb.toLocaleString("da-DK")} kr.`,
        "Beløbet er trukket fra din BidHamr-konto og holdes af os, indtil du bekræfter, at du har modtaget varen. Først da får sælgeren pengene.",
        "Du kan følge handlen og skrive direkte til sælgeren på siden nedenfor.",
      ],
      knapTekst: "Se handlen",
      knapUrl: sideUrl(`/mine-handler/${tradeId}`),
    }),
  };
}

export function saelgerSolgtMail(titel: string, beloeb: number, tradeId: string) {
  return {
    subject: `Din auktion er solgt: ${titel}`,
    html: skabelon({
      overskrift: "Din auktion er solgt",
      afsnit: [
        `<strong>${titel}</strong> blev solgt for ${beloeb.toLocaleString("da-DK")} kr.`,
        "Køberen har betalt, og beløbet står klar. Det sættes ind på din BidHamr-konto — fratrukket 10% sælgergebyr — så snart køberen har bekræftet modtagelsen.",
        "Send varen af sted og indtast sporingsnummeret på handelssiden, så køberen kan følge med.",
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
        `Sælgeren har sendt <strong>${titel}</strong>.`,
        "Når du har modtaget varen, skal du bekræfte modtagelsen på handelssiden — så frigives beløbet til sælgeren.",
      ],
      ekstra: `<p style="margin:0 0 20px 0;padding:12px 16px;background-color:#f5f5f5;border-radius:10px;font-size:14px;color:#171717;">
        Sporingsnummer: <strong>${tracking}</strong>
      </p>`,
      knapTekst: "Se handlen",
      knapUrl: sideUrl(`/mine-handler/${tradeId}`),
    }),
  };
}
