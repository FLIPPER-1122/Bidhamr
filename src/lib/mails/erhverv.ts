// Mails til firmakonti (erhverv). Teksterne ligger i src/lib/tekster/erhverv.ts
// (ERHVERV_VELKOMSTMAIL), så siden, mailen og supabase/templates/invite.html
// siger det samme.
import { bygMail, escapeHtml } from "./layout";
import { ERHVERV_EMAIL } from "@/lib/erhverv/regler";
import { ERHVERV_VELKOMSTMAIL as T, ERHVERV_VELKOMSTMAIL_GENSENDT } from "@/lib/tekster/erhverv";

// Velkomstmail, når BidHamr har oprettet firmakontoen. linkUrl er et
// engangslink, som logger ind og fører til "Vælg din adgangskode".
export function firmaVelkomstMail(input: {
  firmanavn: string;
  email: string;
  linkUrl: string;
  gensendt?: boolean;
}) {
  return {
    subject: T.emne,
    ...bygMail({
      preheader: T.forhaandsvisning,
      overskriftHtml: escapeHtml(T.overskrift),
      afsnitHtml: [
        ...T.tekst.map((t) => escapeHtml(t)),
        escapeHtml(T.udloeber),
        escapeHtml(T.separatKonto),
        escapeHtml(T.hjaelp).replace(ERHVERV_EMAIL, `<a href="mailto:${ERHVERV_EMAIL}">${ERHVERV_EMAIL}</a>`),
      ],
      knap: { tekst: T.knap, url: input.linkUrl },
      aarsag: input.gensendt ? ERHVERV_VELKOMSTMAIL_GENSENDT.fodnote(input.email) : T.fodnote(input.email),
    }),
  };
}
