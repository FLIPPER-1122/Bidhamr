// Tekster til Henvis en ven (/konto/henvis). Reglerne:
// ROADMAP-BESLUTNINGER.md, "Nye funktioner før lancering (Filip, 27. okt. 2026)", punkt 3.
import type { HenvisningStatus } from "@/lib/henvisning/status";

export const HENVISNING_TEKST = {
  sideTitel: "Henvis en ven",
  sideIntro: (point: number) =>
    `Del dit link med en ven. Når din ven har oprettet en konto via linket og bekræftet sig med MitID, får du ${point} boost-point.`,
  linkLabel: "Dit link",
  kopier: "Kopiér link",
  del: "Del",
  delTitel: "BidHamr",
  delTekst: "Kom med på BidHamr – auktioner mellem private. Opret dig via mit link:",
  kopieret: "Linket er kopieret",
  kunneIkkeKopiere: "Kunne ikke kopiere. Markér linket, og kopiér det selv.",

  tal: {
    venner: "Venner via dit link",
    point: "Optjente point",
    maaned: "Belønnede venner i denne måned",
  },
  maanedVaerdi: (antal: number, maks: number) => `${antal} af ${maks}`,

  reglerTitel: "Sådan virker det",
  regler: (point: number, maks: number) => [
    `Du får ${point} boost-point for hver ven, der opretter en ny konto via dit link og bekræfter sig med MitID.`,
    `Du kan få point for højst ${maks} venner pr. kalendermåned (${point * maks} point).`,
    "Du skal selv være bekræftet med MitID for at få point. En ven, der bekræfter sig, før du har gjort det, giver ikke point.",
    "Kun nye konti tæller. Du kan ikke henvise dig selv, og samme person giver kun point én gang.",
    "Pointene kan bruges til at booste dine auktioner.",
  ],
  foerLancering: "Du kan dele dit link nu, men der gives først point, når BidHamr åbner.",
  spaerret: "Din konto kan ikke få point lige nu. Kontakt BidHamr, hvis du har spørgsmål.",
  // Henviseren skal selv være MitID-verificeret (review 27. okt. 2026).
  ikkeVerificeret: "Bekræft dig med MitID for at få point. Venner, der bekræfter sig, før du har gjort det, giver ikke point.",
  kunPrivate: "Henvis en ven er kun for private. Firmakonti kan ikke få boost-point.",
  fejl: "Vi kunne ikke hente dit link lige nu. Prøv igen om lidt.",

  vennerTitel: "Dine venner",
  vennerTom: "Ingen har oprettet sig via dit link endnu.",
  status: {
    afventer: "Venter på MitID",
    belonnet: "Point givet",
    loft: "Månedens loft var nået",
    firma: "Ingen point (firmakonto)",
    spaerret: "Ingen point",
    foer_lancering: "Før BidHamr åbnede",
    samme_person: "Ingen point (din egen MitID)",
    tidligere_konto: "Ingen point (havde en konto før)",
    henviser_uverificeret: "Ingen point (du var ikke bekræftet med MitID)",
  } satisfies Record<HenvisningStatus, string>,

  // Opret konto: feltet med koden fra vennens link (?ven=KODE).
  signupFelt: "Henvisningskode",
  signupHjaelp: "Har en ven sendt dig et link, står vennens kode her. Du kan rette eller slette den.",
  signupKodeUgyldig: "Henvisningskoden er ikke gyldig. Ret den, eller slet den.",

  // Kort på Min konto.
  kortTekst: "Del dit link og få boost-point",
} as const;
