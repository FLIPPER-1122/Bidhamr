// Mails for Digital Services Act: kvittering for en anmeldelse (art. 16(4)),
// afgørelsen til anmelderen (art. 16(5)), begrundelse ved indgreb (art. 17)
// og svar på en klage (art. 20). Alle tekster er escapet her.
import { bygMail, escapeHtml, sideUrl } from "./layout";
import {
  ANDRE_KLAGEMULIGHEDER,
  HANDLING_BRUGER,
  HANDLING_KONSEKVENS,
  anmeldKategoriNavn,
  indholdNavn,
  type DsaHandling,
} from "@/lib/dsa/regler";

const AARSAG_DSA =
  "Du får denne mail, fordi EU's regler for digitale tjenester (DSA) kræver, at vi giver dig besked. Den kan ikke slås fra.";

function dato(iso: string) {
  return new Date(iso).toLocaleString("da-DK", {
    timeZone: "Europe/Copenhagen",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function afsnit(tekst: string): string[] {
  return tekst
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map(escapeHtml);
}

export function anmeldelseKvitteringMail(input: {
  sagsnummer: string;
  indholdType: string;
  kategori: string;
  // Kun et link, BidHamr selv har bygget (fx /auktion/<id>) - aldrig
  // anmelderens fritekst. null = vises ikke.
  placering: string | null;
  oprettet: string;
  statusSti: string;
  haster: boolean;
}) {
  return {
    subject: `Vi har modtaget din anmeldelse (${input.sagsnummer})`,
    ...bygMail({
      preheader: `Tak. Din anmeldelse har sagsnummer ${input.sagsnummer}.`,
      overskriftHtml: "Tak for din anmeldelse",
      afsnitHtml: [
        "Vi har modtaget din anmeldelse, og en medarbejder kigger på den.",
        input.haster
          ? "Den slags anmeldelser behandler vi med det samme – senest inden for 24 timer."
          : "Vi behandler som regel anmeldelser inden for 7 dage.",
        "Du får en mail, når vi har taget stilling. Du kan også følge din anmeldelse via knappen nedenfor.",
      ],
      info: [
        { noegle: "Sagsnummer", vaerdiHtml: escapeHtml(input.sagsnummer) },
        { noegle: "Hvad", vaerdiHtml: escapeHtml(indholdNavn(input.indholdType)) },
        { noegle: "Kategori", vaerdiHtml: escapeHtml(anmeldKategoriNavn(input.kategori)) },
        ...(input.placering && input.placering.startsWith("/")
          ? [{ noegle: "Placering", vaerdiHtml: escapeHtml(sideUrl(input.placering)) }]
          : []),
        { noegle: "Modtaget", vaerdiHtml: escapeHtml(dato(input.oprettet)) },
      ],
      knap: { tekst: "Se din anmeldelse", url: sideUrl(input.statusSti) },
      aarsag: AARSAG_DSA,
    }),
  };
}

export function anmeldelseSvarMail(input: {
  sagsnummer: string;
  udfald: string;
  svar: string | null;
  statusSti: string;
  kanKlage: boolean;
}) {
  const fjernet = input.udfald === "indgreb";
  const overskrift = fjernet
    ? "Vi har grebet ind over for det, du anmeldte"
    : input.udfald === "ikke_fundet"
      ? "Vi kunne ikke finde det, du anmeldte"
      : "Vi har vurderet din anmeldelse";
  const standard = fjernet
    ? "Tak for din anmeldelse. Vi har vurderet, at indholdet bryder loven eller vores regler, og har fjernet eller begrænset det."
    : input.udfald === "ikke_fundet"
      ? "Indholdet findes ikke længere, eller vi kunne ikke finde det ud fra oplysningerne."
      : "Vi har vurderet, at indholdet ikke bryder loven eller vores regler, så det bliver på BidHamr.";
  return {
    subject: `Svar på din anmeldelse (${input.sagsnummer})`,
    ...bygMail({
      preheader: overskrift,
      overskriftHtml: escapeHtml(overskrift),
      afsnitHtml: [
        ...afsnit(input.svar?.trim() || standard),
        ...(input.kanKlage
          ? [
              "Er du uenig? Du kan klage over vores afgørelse inden for 6 måneder. Klagen behandles af en anden medarbejder.",
              escapeHtml(ANDRE_KLAGEMULIGHEDER),
            ]
          : []),
      ],
      info: [{ noegle: "Sagsnummer", vaerdiHtml: escapeHtml(input.sagsnummer) }],
      knap: { tekst: input.kanKlage ? "Se afgørelsen eller klag" : "Se din anmeldelse", url: sideUrl(input.statusSti) },
      aarsag: AARSAG_DSA,
    }),
  };
}

export function afgoerelseMail(input: {
  sagsnummer: string;
  handling: DsaHandling;
  indholdTekst: string | null;
  regelTekst: string;
  fakta: string;
  efterAnmeldelse: boolean;
  automatiskOpdaget: boolean;
  varighedTil: string | null;
  oprettet: string;
  klageFrist: string;
  sti: string;
}) {
  const titel = HANDLING_BRUGER[input.handling] ?? "BidHamr har begrænset dit indhold";
  const hvordan = input.automatiskOpdaget
    ? "Vores automatiske kontrol markerede indholdet, og en medarbejder har vurderet det."
    : input.efterAnmeldelse
      ? "Vi fik en anmeldelse, og en medarbejder har vurderet indholdet."
      : "En medarbejder fandt det ved vores egen gennemgang.";
  const info = [
    { noegle: "Sagsnummer", vaerdiHtml: escapeHtml(input.sagsnummer) },
    ...(input.indholdTekst ? [{ noegle: "Det drejer sig om", vaerdiHtml: escapeHtml(input.indholdTekst) }] : []),
    { noegle: "Regel", vaerdiHtml: escapeHtml(input.regelTekst) },
    ...(input.handling === "konto_suspenderet"
      ? [{ noegle: "Varighed", vaerdiHtml: escapeHtml(input.varighedTil ? `Til ${dato(input.varighedTil)}` : "Indtil videre") }]
      : []),
    { noegle: "Dato", vaerdiHtml: escapeHtml(dato(input.oprettet)) },
    { noegle: "Klag senest", vaerdiHtml: escapeHtml(dato(input.klageFrist)) },
  ];
  return {
    subject: `${titel} (${input.sagsnummer})`,
    ...bygMail({
      preheader: `${titel}. Her er begrundelsen, og sådan klager du.`,
      overskriftHtml: escapeHtml(titel),
      afsnitHtml: [
        escapeHtml(HANDLING_KONSEKVENS[input.handling] ?? ""),
        `<strong>Hvorfor:</strong> ${escapeHtml(input.fakta)}`,
        escapeHtml(hvordan),
        "Er du uenig, kan du klage inden for 6 måneder via knappen nedenfor. Klagen behandles af en anden medarbejder end den, der traf afgørelsen.",
        escapeHtml(ANDRE_KLAGEMULIGHEDER),
      ],
      info,
      knap: { tekst: "Se begrundelsen og klag", url: sideUrl(input.sti) },
      aarsag: AARSAG_DSA,
    }),
  };
}

export function klageSvarMail(input: {
  sagsnummer: string;
  udfald: "medhold" | "fastholdt";
  svar: string;
  sti: string;
  // Medhold over en fjernet/stoppet auktion: den åbnes aldrig igen.
  ikkeGenaabnet?: boolean;
}) {
  const medhold = input.udfald === "medhold";
  const titel = medhold ? "Du har fået medhold i din klage" : "Vi har behandlet din klage";
  return {
    subject: `${titel} (${input.sagsnummer})`,
    ...bygMail({
      preheader: medhold
        ? input.ikkeGenaabnet
          ? "Du får medhold. Auktionen kan ikke åbnes igen, men du kan sætte varen op igen med ét klik."
          : "Vi har ændret vores afgørelse."
        : "Vi fastholder vores afgørelse.",
      overskriftHtml: escapeHtml(titel),
      afsnitHtml: [
        medhold
          ? input.ikkeGenaabnet
            ? "En anden medarbejder har set på sagen igen og giver dig ret. Vi beklager, at vi stoppede din auktion. Den kan ikke åbnes igen, fordi buddene ikke gælder længere – men du kan sætte varen op igen med ét klik under \"Se sagen\"."
            : "En anden medarbejder har set på sagen igen og giver dig ret. Vi har ændret afgørelsen."
          : "En anden medarbejder har set på sagen igen og fastholder afgørelsen.",
        ...afsnit(input.svar),
        ...(medhold ? [] : [escapeHtml(ANDRE_KLAGEMULIGHEDER)]),
      ],
      info: [{ noegle: "Sagsnummer", vaerdiHtml: escapeHtml(input.sagsnummer) }],
      knap: { tekst: "Se sagen", url: sideUrl(input.sti) },
      aarsag: AARSAG_DSA,
    }),
  };
}
