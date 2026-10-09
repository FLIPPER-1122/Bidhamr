import Link from "next/link";
import type { Blokering } from "@/app/actions/kontoSletning";

// Hvad der forhindrer sletning af kontoen, samlet pr. type med ét link til
// oversigten og højst 5 links til de enkelte ting. Typerne kommer fra
// konto_sletning_blokeringer() i databasen.
type TypeInfo = {
  // Overskrift med antal, fx "3 handler i gang".
  titel: (n: number) => string;
  hjaelp: string;
  // Hvad et enkelt link fører til ("auktionen", "handlen" ...).
  enkelt: string;
  oversigt?: (brugerId: string | null) => { href: string; tekst: string } | null;
};

const MINE_HANDLER = () => ({ href: "/mine-handler", tekst: "Se Mine handler" });

const TYPE: Record<string, TypeInfo> = {
  staff: {
    titel: () => "Du er medarbejder hos BidHamr",
    hjaelp: "En chef skal fjerne din medarbejderrolle, før kontoen kan slettes.",
    enkelt: "",
  },
  // Kontoen kan ikke slettes, mens den er suspenderet (MitID, chefens valg
  // 9. okt. 2026): ellers kunne en suspension omgås ved at starte forfra.
  suspenderet: {
    titel: () => "Du kan ikke slette din konto, mens den er suspenderet",
    hjaelp: "Vent, til suspensionen er ophævet. Skriv til support@bidhamr.dk, hvis du har spørgsmål.",
    enkelt: "",
  },
  firmakonto: {
    titel: () => "Det er en firmakonto",
    hjaelp: "En firmakonto lukkes af BidHamr. Skriv til erhverv@bidhamr.dk, så hjælper vi dig.",
    enkelt: "",
  },
  auktion_med_bud: {
    titel: (n) => (n === 1 ? "1 auktion i gang med bud" : `${n} auktioner i gang med bud`),
    hjaelp: "Bud er bindende, så auktionen skal slutte, og handlen gøres færdig.",
    enkelt: "auktionen",
    oversigt: (id) => (id ? { href: `/profil/${id}?fane=auktioner`, tekst: "Se mine auktioner" } : null),
  },
  bud_paa_aktiv: {
    titel: (n) =>
      n === 1
        ? "Du har budt på 1 auktion, der stadig er i gang"
        : `Du har budt på ${n} auktioner, der stadig er i gang`,
    hjaelp: "Dit bud er bindende. Vent, til auktionen er slut.",
    enkelt: "auktionen",
    oversigt: () => ({ href: "/konto/statistik?vis=aktive", tekst: "Se dine bud" }),
  },
  mangler_betaling: {
    titel: (n) => (n === 1 ? "1 handel mangler din betaling" : `${n} handler mangler din betaling`),
    hjaelp: "Betal for varen, eller vent til handlen er annulleret.",
    enkelt: "handlen",
    oversigt: MINE_HANDLER,
  },
  aaben_handel: {
    titel: (n) => (n === 1 ? "1 handel i gang" : `${n} handler i gang`),
    hjaelp: "Handlen skal være afsluttet eller annulleret.",
    enkelt: "handlen",
    oversigt: MINE_HANDLER,
  },
  aaben_sag: {
    titel: (n) => (n === 1 ? "1 sag i gang" : `${n} sager i gang`),
    hjaelp: "Sagen skal være afgjort, og pengene flyttet.",
    enkelt: "handlen",
    oversigt: MINE_HANDLER,
  },
  aaben_anke: {
    titel: (n) => (n === 1 ? "1 anke venter på svar" : `${n} anker venter på svar`),
    hjaelp: "BidHamr skal afgøre anken først.",
    enkelt: "handlen",
    oversigt: MINE_HANDLER,
  },
  aabent_tilbud: {
    titel: (n) => (n === 1 ? "1 tilbud venter på svar" : `${n} tilbud venter på svar`),
    hjaelp: "Svar på tilbuddet, eller vent til det udløber.",
    enkelt: "tilbuddet",
    oversigt: MINE_HANDLER,
  },
  penge_undervejs: {
    titel: (n) => (n === 1 ? "1 betaling er på vej" : `${n} betalinger er på vej`),
    hjaelp: "En betaling, udbetaling eller tilbagebetaling er ikke færdig endnu.",
    enkelt: "handlen",
    oversigt: MINE_HANDLER,
  },
  ubetalt_sag: {
    titel: (n) => (n === 1 ? "1 sag om manglende betaling" : `${n} sager om manglende betaling`),
    hjaelp: "BidHamr skal behandle sagen først.",
    enkelt: "handlen",
    oversigt: MINE_HANDLER,
  },
};

const UKENDT: TypeInfo = {
  titel: (n) => (n === 1 ? "Noget er i gang" : `${n} ting er i gang`),
  hjaelp: "Skriv til support@bidhamr.dk, hvis du er i tvivl.",
  enkelt: "den",
};

const MAKS_LINKS = 5;

export default function Blokeringer({
  blokeringer,
  brugerId = null,
}: {
  blokeringer: Blokering[];
  brugerId?: string | null;
}) {
  // Saml pr. type i den rækkefølge, databasen returnerer dem.
  const grupper = new Map<string, Blokering[]>();
  for (const b of blokeringer) {
    const liste = grupper.get(b.type);
    if (liste) liste.push(b);
    else grupper.set(b.type, [b]);
  }

  return (
    <ul className="space-y-3">
      {[...grupper].map(([type, liste]) => {
        const t = TYPE[type] ?? UKENDT;
        const oversigt = t.oversigt?.(brugerId) ?? null;
        const medLink = ["staff", "firmakonto", "suspenderet"].includes(type) ? [] : liste.filter((b) => b.link);
        const vist = medLink.slice(0, MAKS_LINKS);
        const resten = medLink.length - vist.length;
        return (
          <li key={type} className="rounded-xl border border-advarsel-kant bg-white p-4">
            <p className="text-[15px] font-semibold text-tekst">{t.titel(liste.length)}</p>
            <p className="mt-1 text-[13px] text-tekst-daempet">{t.hjaelp}</p>
            {vist.length > 0 && (
              <ul className="mt-2 space-y-0.5">
                {vist.map((b, i) => (
                  <li key={`${b.link}-${i}`} className="min-w-0">
                    <Link
                      href={b.link!}
                      className="inline-flex min-h-9 max-w-full items-center text-sm font-medium text-groen hover:underline"
                      aria-label={`Gå til ${t.enkelt}: ${b.tekst}`}
                    >
                      <span className="truncate">{b.tekst}</span>
                      <span aria-hidden="true" className="ml-1 shrink-0">
                        →
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {resten > 0 && <p className="mt-1 text-[13px] text-tekst-daempet">… og {resten} mere.</p>}
            {oversigt && (
              <Link href={oversigt.href} className="btn btn-sekundaer btn-lille mt-3 w-full sm:w-auto">
                {oversigt.tekst}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}
