import Link from "next/link";
import ConfirmDialog from "@/components/admin/ConfirmDialog";
import FlereHandlinger from "@/components/admin/FlereHandlinger";
import FaellesbeskedKnap from "@/components/admin/staffchat/FaellesbeskedKnap";
import SkrivTilBrugerKnap from "@/components/admin/SkrivTilBrugerKnap";
import { handelChatSti } from "@/lib/moderationLog";
import { PAAMINDELSE } from "@/lib/tekster/adminSkabeloner";
import type { HaengerGrund } from "@/lib/adminGraenser";
import { fragtGodkendEkstraLabel } from "@/app/actions/adminFragt";
import { handelIkkeAfhentet } from "@/app/actions/adminIkkeAfhentet";
import { sagAabn, sagLuk, handelFrigiv, handelRefunder } from "@/app/actions/adminActions";

// Handlingerne på en handel - samme knapper i listen (/admin/handler) og på
// detaljesiden (/admin/handler/[id]). Kun hvor de står og ser ud er nyt;
// actions er de samme som før, og de tjekker selv rollen.
//
// Én hovedknap pr. række (fx "Send påmindelse", når handlen hænger). Sjældne
// og farlige handlinger ligger under "Flere handlinger". Handlinger, der
// flytter penge, viser beløbet og hvem der får det i bekræftelsen.

export const AKTIVE = ["betaling_modtaget", "pakke_sendt", "modtaget"];

export type HandelTilHandling = {
  id: string;
  status: string;
  amount: number | string;
  sag_aaben: boolean;
  afhentning: boolean | null;
};

type Part = { id: string; navn: string };

const IKKE_AFHENTET_TITEL = "Pakken blev ikke afhentet?";
const IKKE_AFHENTET_TEKST =
  "Brug det, når fragtfirmaet har sendt pakken retur til sælgeren, fordi køberen ikke hentede den. Handlen annulleres. Køberen får købsbeløbet tilbage minus købergebyr, BidHamr Beskyttelse og fragten begge veje (returfragten = fragten ud) – aldrig under 0 kr. Sælgeren beholder varen, betaler ikke for fragten og får intet udbetalt. Begge får besked.";
const IKKE_AFHENTET_AARSAG = {
  label: "Begrundelse (intern)",
  placeholder: "Fx: DAO-sporing viser retur til afsender efter 7 dage i pakkeshoppen",
  required: true,
};

function siden(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (min < 60) return `${min} min.`;
  const t = Math.floor(min / 60);
  return t < 48 ? `${t} t` : `${Math.floor(t / 24)} dage`;
}

export const kr = (v: number | string) =>
  Number(v).toLocaleString("da-DK", { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + " kr";

const lilleKnap =
  "inline-flex min-h-10 items-center whitespace-nowrap rounded-lg border border-kant-staerk bg-white px-3 text-[13px] font-medium text-tekst transition-colors hover:bg-admin-bg lg:min-h-8";
const fareKnap =
  "inline-flex min-h-10 items-center whitespace-nowrap rounded-lg border border-fejl-kant bg-white px-3 text-[13px] font-medium text-fejl-tekst transition-colors hover:bg-fejl-bg lg:min-h-8";

export default function HandelHandlinger({
  h,
  titel,
  koeber,
  saelger,
  haenger,
  returMeldt,
  kanFlyttePenge,
  kanSkriveFaelles,
  visAabn = true,
  sidstPaamindet,
}: {
  h: HandelTilHandling;
  titel: string;
  koeber: Part;
  saelger: Part;
  haenger?: HaengerGrund | null;
  returMeldt: boolean;
  kanFlyttePenge: boolean;
  kanSkriveFaelles: boolean;
  // Link til detaljesiden (ikke på selve detaljesiden).
  visAabn?: boolean;
  // Hvornår staff sidst skrev til den part, påmindelsen går til (eller null).
  sidstPaamindet?: string | null;
}) {
  const aktiv = AKTIVE.includes(h.status);
  // Påmindelse til den part, der skal gøre noget: sælgeren sender, køberen
  // kvitterer for pakken/afhentningen.
  const paamind = haenger
    ? haenger === "ikke_sendt"
      ? { part: saelger, ...PAAMINDELSE.ikke_sendt, hvem: "sælger", rolle: "saelger" as const }
      : { part: koeber, ...PAAMINDELSE[haenger], hvem: "køber", rolle: "koeber" as const }
    : null;
  const parter = [
    { label: "Handel", vaerdi: titel },
    { label: "Køber", vaerdi: koeber.navn },
    { label: "Sælger", vaerdi: saelger.navn },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      {paamind && aktiv && paamind.part.id && (
        <SkrivTilBrugerKnap
          brugerId={paamind.part.id}
          brugerNavn={paamind.part.navn}
          tradeId={h.id}
          knapTekst={`Send påmindelse til ${paamind.hvem}`}
          knapKlasse="btn btn-primaer btn-lille"
          titel={`Påmindelse til ${paamind.part.navn}`}
          emne={paamind.emne}
          tekst={paamind.tekst}
          kvittering="Påmindelsen er sendt"
          paamindelse={{ tradeId: h.id, part: paamind.rolle }}
        />
      )}
      {paamind && aktiv && sidstPaamindet && (
        <span className="text-xs text-tekst-svag">Påmindelse sendt for {siden(sidstPaamindet)}</span>
      )}
      {visAabn && (
        <Link href={`/admin/handler/${h.id}`} className={lilleKnap}>
          Åbn handel
        </Link>
      )}
      {/* prefetch slået fra: chatsiden logger læsningen. */}
      <Link href={handelChatSti(h.id)} prefetch={false} className={lilleKnap}>
        Se chat
      </Link>
      {aktiv && h.sag_aaben && (
        <ConfirmDialog
          triggerLabel="Fjern markering"
          triggerClassName={lilleKnap}
          title="Fjern markeringen?"
          description="Handlen fortsætter normalt. Ingen penge flyttes."
          confirmLabel="Fjern markeringen"
          action={sagLuk}
          hiddenFields={{ tradeId: h.id }}
          fakta={parter}
          aarsagField={{ label: "Afsluttende note", placeholder: "Hvad blev udfaldet?", required: true }}
          kvittering="Markeringen er fjernet"
        />
      )}
      {(kanSkriveFaelles || (aktiv && (!h.sag_aaben || kanFlyttePenge))) && (
        <FlereHandlinger>
          {kanSkriveFaelles && <FaellesbeskedKnap tradeId={h.id} />}
          {/* Sælgeren har brugt sine 2 fragtlabels og har skrevet til os. */}
          {h.status === "betaling_modtaget" && (
            <ConfirmDialog
              triggerLabel="Godkend ekstra fragtlabel"
              triggerClassName={lilleKnap}
              title="Godkend én ekstra fragtlabel?"
              description="Sælgeren må højst lave 2 labels pr. handel. Hvert klik giver én label mere. Kræver, at køberen har valgt levering."
              confirmLabel="Godkend ekstra label"
              action={fragtGodkendEkstraLabel}
              hiddenFields={{ tradeId: h.id }}
              fakta={parter}
              aarsagField={{ label: "Hvorfor?", placeholder: "Fx: sælgeren skrev til support – labelen blev beskadiget", required: true }}
              kvittering="Ekstra label godkendt"
            />
          )}
          {aktiv && !h.sag_aaben && (
            <ConfirmDialog
              triggerLabel="Markér handel"
              triggerClassName={lilleKnap}
              title="Markér handlen til opfølgning?"
              description="Pengene fryses, indtil markeringen fjernes. Parterne kan stadig bruge handlen normalt."
              confirmLabel="Markér handlen"
              action={sagAabn}
              hiddenFields={{ tradeId: h.id }}
              fakta={parter}
              aarsagField={{ label: "Hvad drejer sagen sig om?", placeholder: "Fx: køber melder varen defekt, sælger svarer ikke...", required: true }}
              kvittering="Handlen er markeret, og pengene er frosset"
            />
          )}
          {/* Pakken er sendt retur, fordi køberen ikke hentede den.
              Med returmelding: medarbejder og op. Uden: kun admin/chef. */}
          {!h.afhentning && h.status === "pakke_sendt" && (returMeldt || kanFlyttePenge) && (
            <ConfirmDialog
              triggerLabel="Ikke afhentet"
              triggerClassName={fareKnap}
              title={IKKE_AFHENTET_TITEL}
              description={IKKE_AFHENTET_TEKST}
              confirmLabel="Ja, pakken blev ikke afhentet"
              action={handelIkkeAfhentet}
              hiddenFields={{ tradeId: h.id }}
              fakta={parter}
              fare
              kanIkkeFortrydes
              aarsagField={IKKE_AFHENTET_AARSAG}
              kvittering="Registreret som ikke afhentet"
            />
          )}
          {aktiv && kanFlyttePenge && (
            <>
              <ConfirmDialog
                triggerLabel="Frigiv til sælger"
                triggerClassName={lilleKnap}
                title="Frigiv pengene til sælgeren?"
                description="Sælgeren afregnes (minus 5 % gebyr), som om køberen havde godkendt varen."
                confirmLabel="Frigiv pengene"
                action={handelFrigiv}
                hiddenFields={{ tradeId: h.id }}
                fakta={[
                  { label: "Bud", vaerdi: kr(h.amount) },
                  { label: "Får pengene", vaerdi: `${saelger.navn} (sælger)` },
                  { label: "Handel", vaerdi: titel },
                ]}
                fare
                kanIkkeFortrydes
                aarsagField={{ label: "Begrundelse", placeholder: "Hvorfor frigives beløbet uden køberens godkendelse?", required: true }}
                kvittering="Pengene er frigivet til sælgeren"
              />
              <ConfirmDialog
                triggerLabel="Refundér køber"
                triggerClassName={fareKnap}
                title="Refundér køberen og annullér handlen?"
                description="Køberen får hele det betalte beløb (bud, købergebyr, fragt og evt. BidHamr Beskyttelse) tilbage via Stripe. Er handlen ikke betalt endnu, annulleres betalingen. Sælgeren får intet."
                confirmLabel="Refundér"
                action={handelRefunder}
                hiddenFields={{ tradeId: h.id }}
                fakta={[
                  { label: "Bud", vaerdi: `${kr(h.amount)} + gebyr, fragt og evt. BidHamr Beskyttelse` },
                  { label: "Får pengene", vaerdi: `${koeber.navn} (køber)` },
                  { label: "Handel", vaerdi: titel },
                ]}
                fare
                kanIkkeFortrydes
                aarsagField={{ label: "Begrundelse", placeholder: "Hvorfor refunderes køberen?", required: true }}
                kvittering="Refusionen er sat i gang"
              />
            </>
          )}
        </FlereHandlinger>
      )}
    </div>
  );
}
