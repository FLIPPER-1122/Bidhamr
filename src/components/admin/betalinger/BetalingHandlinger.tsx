import Link from "next/link";
import type { ReactNode } from "react";
import ConfirmDialog from "@/components/admin/ConfirmDialog";
import { advarselFelter } from "@/components/admin/advarselFelter";
import { handelChatSti } from "@/lib/moderationLog";
import {
  markerBetalingLøstForm,
  givAdvarselBetalingForm,
  proevTilbagebetalingIgenForm,
  type BetalingTilHandling,
} from "@/app/actions/adminBetalinger";
import { prøvOverfoerselIgenForm, handelFrigiv, handelRefunder } from "@/app/actions/adminActions";

// Knapper og forklaring på et betalingskort under /admin/betalinger. Hvilke
// knapper der vises, afgøres af betalingens problemtype (b.problem), så staff
// kun ser de handlinger, der giver mening for netop det problem.
// Ingen nye pengeflows: Frigiv/Refundér er de samme server actions og
// bekræftelser som på /admin/handler, og serveren tjekker rolle og tilstand.

const KNAP =
  "inline-flex w-full items-center justify-center whitespace-nowrap rounded-lg px-4 py-2 text-sm font-semibold transition-colors sm:w-52";
const KNAP_HVID = `${KNAP} border border-neutral-300 bg-white text-neutral-800 hover:bg-neutral-100`;
const KNAP_ORANGE = `${KNAP} bg-orange-knap text-white hover:bg-orange-knap-mork`;
const KNAP_GROEN = `${KNAP} border border-succes-kant bg-succes-bg text-succes-tekst hover:bg-groen-lys`;
const KNAP_ROED = `${KNAP} border border-fejl-kant bg-fejl-bg text-fejl-tekst hover:bg-red-100`;

// Én linje øverst i kortet: hvad er problemet, og hvad gør staff typisk.
export function problemTekst(b: BetalingTilHandling): { titel: string; tekst: string } {
  switch (b.problem) {
    case "afhentning":
      return {
        titel: "Varen er ikke hentet",
        tekst:
          "Afhentningen er ikke gennemført, eller koden er låst efter for mange forkerte forsøg. Kontakt køber og sælger, og afgør så, om køberen skal have pengene tilbage, eller sælgeren skal have dem.",
      };
    case "ikke_afsluttet":
      return {
        titel: "Handlen er ikke afsluttet",
        tekst:
          "Køberen har betalt, men handlen er gået i stå. Tjek chatten, og afgør så, om køberen skal have pengene tilbage, eller sælgeren skal have dem.",
      };
    case "overfoersel":
      return {
        titel: "Overførslen til sælgeren fejlede",
        tekst:
          "Pengene er frigivet, men nåede ikke frem til sælgerens konto. Prøv overførslen igen. Fejler den igen, så kontakt sælgeren om udbetalingskontoen.",
      };
    case "refusion":
      if (b.refusion?.tilstand === "gennemfoert") {
        return {
          titel: "Køberen har fået pengene tilbage",
          tekst:
            "Tilbagebetalingen er gennemført, efter et tidligere forsøg fejlede. Tjek evt. i Stripe, og markér som løst.",
        };
      }
      if (b.refusion?.tilstand === "afventer") {
        return {
          titel: "Tilbagebetaling i gang",
          tekst:
            "Køberen skal have pengene tilbage, og tilbagebetalingen er sendt til Stripe. Markeringen forsvinder af sig selv, når Stripe bekræfter den. Står den stille, så prøv igen eller tjek i Stripe.",
        };
      }
      return {
        titel: "Tilbagebetalingen til køberen fejlede",
        tekst: b.refusion?.proeverSelv
          ? "Køberens penge kunne ikke sendes tilbage. Systemet prøver selv igen, og du kan prøve igen med det samme. Lykkes det ikke: tjek årsagen i Stripe, kontakt køberen, og markér som løst, når køberen har fået pengene på anden vis."
          : "Køberens penge kunne ikke sendes tilbage, og systemet prøver ikke selv igen. Prøv tilbagebetalingen igen. Lykkes det ikke: tjek årsagen i Stripe, kontakt køberen, og markér som løst, når køberen har fået pengene på anden vis.",
      };
    case "indsigelse":
      return {
        titel: "Køberen har gjort indsigelse hos sin bank",
        tekst:
          "Banken afgør sagen. Vent på udfaldet – betalingen kan ikke markeres som løst, før indsigelsen er afgjort.",
      };
    default:
      return {
        titel: "Betalingen kræver et kig",
        tekst: "Læs fejlbeskeden nedenfor, tjek handlen, og markér som løst, når det er klaret.",
      };
  }
}

// Badge for betalingens status. Ved refusion afgøres teksten af de rigtige
// felter (refunderet_kl/status), så badge og forklaring aldrig modsiger hinanden.
export function statusBadge(b: BetalingTilHandling, standard: string): { tekst: string; farve: string } {
  const graa = "bg-neutral-100 text-neutral-700";
  if (b.refusion) {
    if (b.refusion.tilstand === "fejlet") {
      return { tekst: "Tilbagebetaling fejlet", farve: "bg-fejl-bg text-fejl-tekst" };
    }
    if (b.refusion.tilstand === "afventer") return { tekst: "Tilbagebetaling i gang", farve: graa };
    return { tekst: "Refunderet", farve: graa };
  }
  return { tekst: standard, farve: graa };
}

function Handling({ knap, forklaring }: { knap: ReactNode; forklaring: string }) {
  return (
    <li className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
      <div className="shrink-0">{knap}</div>
      <p className="text-xs text-neutral-600">{forklaring}</p>
    </li>
  );
}

export default function BetalingHandlinger({
  b,
  kanLoese,
}: {
  b: BetalingTilHandling;
  // Admin/chef (samme rolle som server actions kræver).
  kanLoese: boolean;
}) {
  const p = b.problem;
  const visPengeKnapper = b.kanFlyttePenge && (p === "afhentning" || p === "ikke_afsluttet");
  const visAdvarsel = kanLoese && (p === "afhentning" || p === "ikke_afsluttet" || p === "andet");
  const visLoest = kanLoese && p !== "indsigelse";

  const seChat = (
    <Handling
      knap={
        // prefetch slået fra: chatsiden logger læsningen.
        <Link href={handelChatSti(b.trade_id)} prefetch={false} className={KNAP_HVID}>
          Se chat
        </Link>
      }
      forklaring="Læs beskederne mellem køber og sælger."
    />
  );

  return (
    <ul className="mt-4 space-y-3 border-t border-neutral-100 pt-4">
      {b.kanProeveOverfoersel && p === "overfoersel" && (
        <Handling
          knap={
            <ConfirmDialog
              triggerLabel="Prøv overførsel igen"
              triggerClassName={KNAP_ORANGE}
              title="Prøv overførslen til sælger igen?"
              description="Overførslen får nye forsøg og prøves med det samme. Betalingen forbliver markeret, indtil pengene faktisk er overført."
              confirmLabel="Prøv igen"
              action={prøvOverfoerselIgenForm}
              hiddenFields={{ tradeId: b.trade_id }}
            />
          }
          forklaring="Sender pengene til sælgerens konto igen med det samme."
        />
      )}

      {b.kanProeveRefusion && p === "refusion" && (
        <Handling
          knap={
            <ConfirmDialog
              triggerLabel="Prøv tilbagebetaling igen"
              triggerClassName={KNAP_ORANGE}
              title="Prøv tilbagebetalingen til køberen igen?"
              description="Stripe spørges først, om pengene allerede er sendt tilbage – så bliver køberen aldrig betalt to gange. Ellers får tilbagebetalingen et nyt forsøg med det samme. Markeringen forsvinder af sig selv, når Stripe bekræfter tilbagebetalingen."
              confirmLabel="Prøv igen"
              action={proevTilbagebetalingIgenForm}
              hiddenFields={{ betalingId: b.id }}
            />
          }
          forklaring="Prøver at sende pengene tilbage til køberen igen via Stripe."
        />
      )}

      {p === "refusion" && kanLoese && b.stripeLink && (
        <Handling
          knap={
            <a href={b.stripeLink} target="_blank" rel="noopener noreferrer" className={KNAP_HVID}>
              Åbn i Stripe
            </a>
          }
          forklaring="Se betalingen og årsagen til fejlen hos Stripe (åbner i en ny fane)."
        />
      )}

      {seChat}

      {visPengeKnapper && (
        <>
          <Handling
            knap={
              <ConfirmDialog
                triggerLabel="Refundér køber"
                triggerClassName={KNAP_ROED}
                title="Refundér køberen og annullér handlen?"
                description="Køberen får hele det betalte beløb (bud, købergebyr, fragt og evt. BidHamr Beskyttelse) tilbage via Stripe. Sælgeren får intet. Kan ikke fortrydes."
                confirmLabel="Ja, refundér"
                action={handelRefunder}
                hiddenFields={{ tradeId: b.trade_id }}
                aarsagField={{ label: "Begrundelse", placeholder: "Hvorfor refunderes køberen?", required: true }}
              />
            }
            forklaring="Køberen får pengene tilbage via Stripe, og handlen annulleres. Markér bagefter som løst."
          />
          <Handling
            knap={
              <ConfirmDialog
                triggerLabel="Frigiv til sælger"
                triggerClassName={KNAP_GROEN}
                title="Frigiv pengene til sælgeren?"
                description="Sælgeren afregnes (minus 5% gebyr), som om køberen havde godkendt varen. Kan ikke fortrydes."
                confirmLabel="Ja, frigiv pengene"
                action={handelFrigiv}
                hiddenFields={{ tradeId: b.trade_id }}
                aarsagField={{
                  label: "Begrundelse",
                  placeholder: "Hvorfor frigives beløbet uden køberens godkendelse?",
                  required: true,
                }}
              />
            }
            forklaring="Sælgeren får sin udbetaling. Markeringen forsvinder, når pengene er overført."
          />
        </>
      )}

      {visAdvarsel && (
        <Handling
          knap={
            <ConfirmDialog
              triggerLabel="Giv advarsel"
              triggerClassName={KNAP_HVID}
              title="Giv advarsel og luk sagen?"
              description="Advarslen tæller med i reglen om 3 advarsler. Betalingen markeres som løst. Pengene flyttes ikke."
              confirmLabel="Giv advarsel"
              action={givAdvarselBetalingForm}
              hiddenFields={{ betalingId: b.id }}
              valgField={{
                name: "modtager",
                label: "Hvem får advarslen?",
                valg: [
                  { value: "koeber", label: b.koeber.navn ? `Køber (${b.koeber.navn})` : "Køber" },
                  { value: "saelger", label: b.saelger.navn ? `Sælger (${b.saelger.navn})` : "Sælger" },
                ],
              }}
              tekstFelter={advarselFelter({
                internNavn: "begrundelse",
                brugerPlaceholder: "Fx: Du sendte ikke varen, selvom køberen havde betalt.",
                internPlaceholder: "Fx: Sendte ikke varen trods flere påmindelser",
              })}
            />
          }
          forklaring="Køber eller sælger får en advarsel, og markeringen fjernes. Pengene flyttes ikke."
        />
      )}

      {visLoest && (
        <Handling
          knap={
            <ConfirmDialog
              triggerLabel="Markér som løst"
              triggerClassName={KNAP_HVID}
              title="Markér betalingen som løst?"
              description="Betalingen forsvinder fra listen. Pengene flyttes ikke. Skriv, hvad der er gjort."
              confirmLabel="Markér som løst"
              action={markerBetalingLøstForm}
              hiddenFields={{ betalingId: b.id }}
              aarsagField={{
                name: "note",
                label: "Note",
                placeholder: "Fx: Køber har fået pengene tilbage via bankoverførsel",
                required: true,
              }}
            />
          }
          forklaring="Fjerner markeringen. Pengene flyttes ikke."
        />
      )}
    </ul>
  );
}
