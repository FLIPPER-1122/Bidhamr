// Intern mail til support@bidhamr.dk, når nogen sender kontaktformularen
// (/kontakt). Al brugertekst escapes her; emnelinjen renses for linjeskift og
// kontroltegn, så den ikke kan bruges til header-injektion.
import { bygMail, escapeHtml, sideUrl } from "./layout";
import { kontaktEmneNavn } from "@/lib/tryghed";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Strengere end formularens tjek: ingen tegn, der kan give flere modtagere
// eller ødelægge en adresse-header (komma, semikolon, <>, anførselstegn).
const SIKKER_EMAIL = /^[^\s@,;<>"'()\\]+@[^\s@,;<>"'()\\]+\.[^\s@,;<>"'()\\]{2,}$/;

// Fjerner linjeskift og andre kontroltegn og samler mellemrum.
function enLinje(tekst: string): string {
  return tekst
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function afkort(tekst: string, maks: number): string {
  return tekst.length > maks ? `${tekst.slice(0, maks - 1).trimEnd()}…` : tekst;
}

export function erSikkerSvarAdresse(email: string): boolean {
  return email.length <= 254 && SIKKER_EMAIL.test(email);
}

export function kontaktSupportMail(input: {
  emne: string;
  besked: string;
  email: string;
  handelsRef: string | null;
  // Sat, når handlen er verificeret som brugerens egen.
  tradeId: string | null;
  brugerId: string | null;
  tidspunkt: Date;
}) {
  const emneNavn = kontaktEmneNavn(input.emne);
  const start = afkort(enLinje(input.besked), 60);
  const subject = afkort(enLinje(`Kontaktformular: ${emneNavn} – ${start}`), 150);

  const tid = input.tidspunkt.toLocaleString("da-DK", {
    timeZone: "Europe/Copenhagen",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const sikkerEmail = erSikkerSvarAdresse(input.email);
  const emailHtml = sikkerEmail
    ? `<a href="mailto:${escapeHtml(input.email)}">${escapeHtml(input.email)}</a>`
    : escapeHtml(input.email);

  // Link til handlen i admin kun for et gyldigt id (aldrig rå tekst i en URL).
  let handelHtml: string | null = null;
  let handelUrl: string | null = null;
  if (input.handelsRef) {
    const id = input.tradeId ?? (UUID.test(input.handelsRef) ? input.handelsRef : null);
    const tekst = escapeHtml(input.handelsRef);
    const note = escapeHtml(input.tradeId ? "" : " (ikke knyttet til afsenderens handler)");
    handelUrl = id ? sideUrl(`/admin/handler/${id.toLowerCase()}`) : null;
    handelHtml = handelUrl ? `<a href="${escapeHtml(handelUrl)}">${tekst}</a>${note}` : `${tekst}${note}`;
  }

  const brugerUrl =
    input.brugerId && UUID.test(input.brugerId) ? sideUrl(`/admin/brugere/${input.brugerId}`) : null;
  const brugerHtml = brugerUrl ? `Ja – <a href="${escapeHtml(brugerUrl)}">se brugeren</a>` : "Nej";

  const beskedHtml = input.besked
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => escapeHtml(l))
    .join("<br>");

  const info = [
    { noegle: "Emne", vaerdiHtml: escapeHtml(emneNavn) },
    { noegle: "Afsender", vaerdiHtml: emailHtml },
    { noegle: "Logget ind", vaerdiHtml: brugerHtml },
    ...(handelHtml ? [{ noegle: "Handels-id", vaerdiHtml: handelHtml }] : []),
    { noegle: "Modtaget", vaerdiHtml: escapeHtml(tid) },
  ];

  const { html, text } = bygMail({
    preheader: start,
    overskriftHtml: "Ny henvendelse fra kontaktformularen",
    afsnitHtml: [
      sikkerEmail
        ? "Tryk på Svar for at skrive direkte til afsenderen."
        : "Afsenderens adresse kunne ikke sættes som svaradresse. Kopiér den fra oplysningerne nedenfor.",
      `<strong>Besked:</strong><br>${beskedHtml}`,
    ],
    info,
    knap: { tekst: "Åbn henvendelser i admin", url: sideUrl("/admin/kontakt") },
    aarsag: "Intern mail: sendt automatisk fra kontaktformularen på bidhamr.dk.",
  });

  // Tekstudgaven mister links i infoboksen; skriv admin-links ud til sidst.
  const links = [
    ...(brugerUrl ? [`Brugeren i admin: ${brugerUrl}`] : []),
    ...(handelUrl ? [`Handlen i admin: ${handelUrl}`] : []),
  ];
  const tekst =
    links.length > 0 ? text.replace("\n\n--\n", `\n${links.join("\n")}\n\n--\n`) : text;

  return {
    subject,
    ...(sikkerEmail ? { replyTo: input.email } : {}),
    html,
    text: tekst,
  };
}
