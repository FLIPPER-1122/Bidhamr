// Mail til vinderen af den månedlige lodtrækning om et gavekort (Filip,
// 15. okt. 2026). Sendes af src/lib/konkurrence/vinderBesked.ts, så snart der
// er trukket lod. Teksterne står i src/lib/tekster/konkurrence.ts.
import { bygMail, escapeHtml, sideUrl } from "./layout";
import { KONKURRENCE_VINDER, maanedNavn } from "@/lib/tekster/konkurrence";

// link: intern sti til samtalen med BidHamr (/beskeder/bidhamr/<id>), eller
// null, hvis samtalen ikke kunne åbnes - så svarer vinderen på mail.
export function konkurrenceVinderMail(input: { maaned: string; frist: string; link: string | null }) {
  const t = KONKURRENCE_VINDER.mail;
  const frist = escapeHtml(input.frist);
  return {
    subject: t.emne,
    ...bygMail({
      preheader: t.preheader(input.frist),
      overskriftHtml: escapeHtml(t.overskrift),
      afsnitHtml: [
        escapeHtml(t.intro(input.maaned)),
        input.link
          ? escapeHtml(t.svarBeskeder(input.frist)).replace(frist, `<strong>${frist}</strong>`)
          : escapeHtml(t.svarKontakt(input.frist)).replace(frist, `<strong>${frist}</strong>`),
        escapeHtml(t.frist),
        escapeHtml(t.samtykke),
        escapeHtml(t.sikkerhed),
      ],
      info: [
        { noegle: t.infoMaaned, vaerdiHtml: escapeHtml(maanedNavn(input.maaned)) },
        { noegle: t.infoFrist, vaerdiHtml: frist, fremhaev: true },
      ],
      knap: input.link
        ? { tekst: t.knapBeskeder, url: sideUrl(input.link) }
        : { tekst: t.knapKontakt, url: sideUrl("/kontakt") },
      aarsag: t.aarsag,
    }),
  };
}
