// Mails til firmakonti (erhverv). Teksterne ligger i src/lib/tekster/erhverv.ts
// (ERHVERV_VELKOMSTMAIL), så siden, mailen og supabase/templates/invite.html
// siger det samme.
import { bygMail, escapeHtml, sideUrl } from "./layout";
import { ERHVERV_EMAIL } from "@/lib/erhverv/regler";
import {
  ERHVERV_VELKOMSTMAIL as T,
  ERHVERV_VELKOMSTMAIL_GENSENDT,
  FIRMA_ABONNEMENT_MAIL as M,
} from "@/lib/tekster/erhverv";

// Mail til firmaet, når BidHamr ændrer abonnementet (pakke, pris, rabat,
// gratis periode) eller beder om et nyt kort. Teksterne:
// FIRMA_ABONNEMENT_MAIL. Knappen fører til Firma oversigt -> Abonnement.
export function firmaAbonnementMail(input: { emne: string; overskrift: string; afsnit: readonly string[]; knap?: string }) {
  return {
    subject: input.emne,
    ...bygMail({
      preheader: input.afsnit[1] ?? input.overskrift,
      overskriftHtml: escapeHtml(input.overskrift),
      afsnitHtml: [
        ...input.afsnit.map((t) => escapeHtml(t)),
        escapeHtml(M.hjaelp).replace(ERHVERV_EMAIL, `<a href="mailto:${ERHVERV_EMAIL}">${ERHVERV_EMAIL}</a>`),
      ],
      knap: { tekst: input.knap ?? M.knap, url: sideUrl("/firma/abonnement") },
      aarsag: M.fodnote,
    }),
  };
}

// Velkomstmail, når BidHamr har oprettet firmakontoen. linkUrl er et
// engangslink, som logger ind og fører til "Vælg din adgangskode".
export function firmaVelkomstMail(input: {
  firmanavn: string;
  email: string;
  linkUrl: string;
  // Hvor længe linket virker: 24 (BidHamrs billet, standard) eller 1
  // (Supabases eget link - reserve, se velkomstMailLink i adminErhverv.ts).
  linkTimer?: number;
  gensendt?: boolean;
}) {
  return {
    subject: T.emne,
    ...bygMail({
      preheader: T.forhaandsvisning,
      overskriftHtml: escapeHtml(T.overskrift),
      afsnitHtml: [
        ...T.tekst.map((t) => escapeHtml(t)),
        escapeHtml(input.linkTimer === 1 ? T.udloeber1Time : T.udloeber),
        escapeHtml(T.separatKonto),
        escapeHtml(T.hjaelp).replace(ERHVERV_EMAIL, `<a href="mailto:${ERHVERV_EMAIL}">${ERHVERV_EMAIL}</a>`),
      ],
      knap: { tekst: T.knap, url: input.linkUrl },
      aarsag: input.gensendt ? ERHVERV_VELKOMSTMAIL_GENSENDT.fodnote(input.email) : T.fodnote(input.email),
    }),
  };
}
