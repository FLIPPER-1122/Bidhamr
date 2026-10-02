// Fælles e-mail-layout for alle BidHamr-mails (handel, notifikationer,
// venteliste). Tabelbaseret med inline CSS, så det virker i Gmail, Outlook
// (Windows), Apple Mail og på mobil. Ingen server-only-import: preview-siden
// i dev bruger det også.
//
// Regler:
// - Mails kan ikke bruge CSS-variabler, så farverne fra DESIGN.md staves ud.
// - Webfonts virker ikke i Outlook/Gmail, og vi henter dem ikke udefra
//   (privatliv). Skriftstakkene starter med Fraunces/Inter, så de bruges, hvis
//   modtageren har dem installeret, og falder ellers tilbage til systemskrift.
// - Alt, der indsættes som tekst, skal være escapet af kalderen. Felter, der
//   hedder "Html", forventes at være færdig, sikker HTML.

const FARVE = {
  groen: "#1E5E4A",
  groenMork: "#154537",
  groenLys: "#E8F2EE",
  orangeDekor: "#E8772E", // kun flade uden tekst ovenpå
  orangeKnap: "#B85518", // hvid tekst ovenpå: 4,83:1 (WCAG AA)
  tekst: "#1A1A1A",
  tekstDaempet: "#555555",
  tekstSvag: "#666666",
  kant: "#EEEEEE",
  succesKant: "#B9D8CC",
  flade: "#FFFFFF",
} as const;

const SERIF = "Fraunces, Georgia, 'Times New Roman', Times, serif";
const SANS =
  "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function sideUrl(sti: string) {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "https://bidhamr.dk";
  return `${base}${sti}`;
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

export type InfoRaekke = {
  // Ren tekst - escapes her.
  noegle: string;
  // Færdig HTML (escapet af kalderen).
  vaerdiHtml: string;
  // Fed og lidt større, fx totalbeløbet.
  fremhaev?: boolean;
};

export type MailLayoutInput = {
  // Skjult forhåndsvisning i indbakken. Ren tekst - escapes her.
  preheader: string;
  // Færdig HTML (escapet af kalderen).
  overskriftHtml: string;
  // Afsnit som færdig HTML (escapet af kalderen).
  afsnitHtml: string[];
  info?: InfoRaekke[];
  // Ren tekst - escapes her. url skal være absolut.
  knap?: { tekst: string; url: string };
  sekundaer?: { tekst: string; url: string };
  // Kort linje om hvorfor modtageren får mailen. Ren tekst - escapes her.
  aarsag: string;
  // Vis link til /konto/notifikationer i footeren.
  indstillingsLink?: boolean;
};

function infoboks(raekker: InfoRaekke[]) {
  const rows = raekker
    .map((r, i) => {
      const kant = i === 0 ? "" : `border-top:1px solid ${FARVE.succesKant};`;
      const vaerdiStil = r.fremhaev
        ? `font-size:17px;font-weight:700;color:${FARVE.tekst};`
        : `font-size:14px;font-weight:600;color:${FARVE.tekst};`;
      return `<tr>
                  <td class="bh-info-noegle" valign="top" style="${kant}padding:10px 0;white-space:nowrap;font-family:${SANS};font-size:14px;line-height:1.5;color:${FARVE.tekstDaempet};">${escapeHtml(r.noegle)}</td>
                  <td class="bh-info-vaerdi" valign="top" align="right" style="${kant}padding:10px 0 10px 16px;font-family:${SANS};line-height:1.4;text-align:right;${vaerdiStil}">${r.vaerdiHtml}</td>
                </tr>`;
    })
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bh-info" style="margin:4px 0 24px 0;background-color:${FARVE.groenLys};border-radius:10px;">
            <tr>
              <td style="padding:6px 20px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                ${rows}
                </table>
              </td>
            </tr>
          </table>`;
}

// "Bulletproof" knap: VML i Outlook på Windows, almindelig tabel/link ellers.
// Hele fladen er klikbar begge steder.
function knapHtml(tekst: string, url: string) {
  const t = escapeHtml(tekst);
  const u = escapeHtml(url);
  // Bredden i Outlook skal være fast; skønnes ud fra tekstens længde.
  const vmlBredde = Math.max(160, Math.round(tekst.length * 9.5 + 64));
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 0 0;">
            <tr>
              <td align="left">
                <!--[if mso]>
                <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${u}" style="height:48px;v-text-anchor:middle;width:${vmlBredde}px;" arcsize="21%" stroke="f" fillcolor="${FARVE.orangeKnap}">
                  <w:anchorlock/>
                  <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">${t}</center>
                </v:roundrect>
                <![endif]-->
                <!--[if !mso]><!-- -->
                <a href="${u}" target="_blank" class="bh-knap" style="display:inline-block;background-color:${FARVE.orangeKnap};color:#ffffff;font-family:${SANS};font-size:15px;font-weight:600;line-height:20px;text-align:center;text-decoration:none;padding:14px 28px;border-radius:10px;mso-hide:all;">${t}</a>
                <!--<![endif]-->
              </td>
            </tr>
          </table>`;
}

const STIL = `
      :root { color-scheme: light dark; supported-color-schemes: light dark; }
      body { margin:0 !important; padding:0 !important; width:100% !important; }
      table { border-collapse:collapse; mso-table-lspace:0pt; mso-table-rspace:0pt; }
      img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
      a { color:${FARVE.groen}; }
      @media only screen and (max-width:620px) {
        .bh-ydre { padding:16px 8px !important; }
        .bh-kort-indhold { padding:28px 20px 24px 20px !important; }
        .bh-h1 { font-size:24px !important; }
        .bh-header, .bh-footer { padding-left:12px !important; padding-right:12px !important; }
        .bh-knap { display:block !important; }
      }
      @media (prefers-color-scheme: dark) {
        .bh-krop, .bh-ydre { background-color:#0F1A16 !important; }
        .bh-kort { background-color:#17241F !important; }
        .bh-h1, .bh-afsnit, .bh-afsnit strong, .bh-info-vaerdi { color:#F2F2F2 !important; }
        .bh-info { background-color:#1F3A30 !important; }
        .bh-info-noegle, .bh-footer-tekst { color:#C8D3CE !important; }
        .bh-logo, .bh-link, .bh-footer-tekst a { color:#9FD3BE !important; }
      }
      [data-ogsc] .bh-krop, [data-ogsc] .bh-ydre { background-color:#0F1A16 !important; }
      [data-ogsc] .bh-kort { background-color:#17241F !important; }
      [data-ogsc] .bh-h1, [data-ogsc] .bh-afsnit, [data-ogsc] .bh-info-vaerdi { color:#F2F2F2 !important; }
      [data-ogsc] .bh-info { background-color:#1F3A30 !important; }
      [data-ogsc] .bh-info-noegle, [data-ogsc] .bh-footer-tekst { color:#C8D3CE !important; }
      [data-ogsc] .bh-logo, [data-ogsc] .bh-link { color:#9FD3BE !important; }
`;

// HTML-fragment til ren tekst (til tekstudgaven af mailen).
function tilRenTekst(html: string) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

// Tekstudgave (multipart/alternative): bedre levering og læsbar i klienter,
// der ikke viser HTML.
export function mailTekst(input: MailLayoutInput): string {
  const dele: string[] = ["BidHamr", "", tilRenTekst(input.overskriftHtml), ""];
  for (const a of input.afsnitHtml) dele.push(tilRenTekst(a), "");
  if (input.info && input.info.length > 0) {
    for (const r of input.info) dele.push(`${r.noegle}: ${tilRenTekst(r.vaerdiHtml)}`);
    dele.push("");
  }
  if (input.knap) dele.push(`${input.knap.tekst}: ${input.knap.url}`);
  if (input.sekundaer) dele.push(`${input.sekundaer.tekst}: ${input.sekundaer.url}`);
  dele.push("", "--", input.aarsag);
  if (input.indstillingsLink) {
    dele.push(`Vælg hvilke beskeder du får: ${sideUrl("/konto/notifikationer")}`);
  }
  dele.push("BidHamr · support@bidhamr.dk");
  return dele.join("\n");
}

// Bygger både HTML- og tekstudgaven.
export function bygMail(input: MailLayoutInput): { html: string; text: string } {
  return { html: mailLayout(input), text: mailTekst(input) };
}

export function mailLayout(input: MailLayoutInput): string {
  const afsnit = input.afsnitHtml
    .map(
      (t) =>
        `<p class="bh-afsnit" style="margin:0 0 16px 0;font-family:${SANS};font-size:15px;line-height:1.55;color:${FARVE.tekst};">${t}</p>`,
    )
    .join("\n          ");

  const sekundaer = input.sekundaer
    ? `<p style="margin:20px 0 0 0;font-family:${SANS};font-size:14px;line-height:1.5;">
            <a href="${escapeHtml(input.sekundaer.url)}" target="_blank" class="bh-link" style="color:${FARVE.groen};font-weight:500;text-decoration:underline;">${escapeHtml(input.sekundaer.tekst)}</a>
          </p>`
    : "";

  const indstillinger = input.indstillingsLink
    ? ` <a href="${escapeHtml(sideUrl("/konto/notifikationer"))}" target="_blank" style="color:${FARVE.tekstSvag};text-decoration:underline;">Vælg hvilke beskeder du får</a>.`
    : "";

  // Fylder forhåndsvisningen ud, så klienten ikke viser brødtekst efter preheaderen.
  const fyld = "&#847;&zwnj;&nbsp;".repeat(40);

  return `<!DOCTYPE html>
<html lang="da" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="x-apple-disable-message-reformatting">
    <meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
    <meta name="color-scheme" content="light dark">
    <meta name="supported-color-schemes" content="light dark">
    <title>BidHamr</title>
    <!--[if mso]>
    <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
    <style>td, p, a, h1, span { font-family: Arial, Helvetica, sans-serif !important; } h1 { font-family: Georgia, serif !important; }</style>
    <![endif]-->
    <style>${STIL}</style>
  </head>
  <body class="bh-krop" style="margin:0;padding:0;background-color:${FARVE.groenLys};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
    <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(input.preheader)}${fyld}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bh-ydre" style="background-color:${FARVE.groenLys};">
      <tr>
        <td align="center" class="bh-ydre" style="padding:32px 16px;">
          <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
            <tr>
              <td class="bh-header" style="padding:0 8px 20px 8px;">
                <a href="${escapeHtml(sideUrl("/"))}" target="_blank" class="bh-logo" style="font-family:${SANS};font-size:24px;font-weight:700;line-height:28px;color:${FARVE.groen};text-decoration:none;">BidHamr</a>
              </td>
            </tr>
            <tr>
              <td class="bh-kort" style="background-color:${FARVE.flade};border-radius:14px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td class="bh-kort-indhold" style="padding:36px 40px 32px 40px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px 0;">
            <tr><td width="32" height="4" style="width:32px;height:4px;font-size:0;line-height:0;background-color:${FARVE.orangeDekor};border-radius:2px;">&nbsp;</td></tr>
          </table>
          <h1 class="bh-h1" style="margin:0 0 16px 0;font-family:${SERIF};font-size:26px;font-weight:600;line-height:1.2;color:${FARVE.tekst};">${input.overskriftHtml}</h1>
          ${afsnit}
          ${input.info && input.info.length > 0 ? infoboks(input.info) : ""}
          ${input.knap ? knapHtml(input.knap.tekst, input.knap.url) : ""}
          ${sekundaer}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td class="bh-footer" style="padding:24px 8px 0 8px;">
                <p class="bh-footer-tekst" style="margin:0 0 8px 0;font-family:${SANS};font-size:12px;line-height:1.5;color:${FARVE.tekstSvag};">${escapeHtml(input.aarsag)}${indstillinger}</p>
                <p class="bh-footer-tekst" style="margin:0;font-family:${SANS};font-size:12px;line-height:1.5;color:${FARVE.tekstSvag};">BidHamr · <a href="mailto:support@bidhamr.dk" style="color:${FARVE.tekstSvag};text-decoration:underline;">support@bidhamr.dk</a></p>
              </td>
            </tr>
          </table>
          <!--[if mso]></td></tr></table><![endif]-->
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
