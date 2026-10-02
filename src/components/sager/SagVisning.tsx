// Sagen på handelssiden - for både køber og sælger. Server-komponent.
// Ingen beløb vises. BidHamr holder aldrig pengene: betalingen håndteres af
// vores betalingspartner Stripe.
import type { MinSag } from "@/app/actions/sager";
import { SAG_MAKS_BILLEDER, SAG_TYPE_NAVN } from "@/lib/sager";
import TilfoejSagBilleder from "./TilfoejSagBilleder";
import { BeskyttelseBadge, SagBilleder, SagStatusBadge, sagTid } from "./visning";

type Boks = { tone: "advarsel" | "info" | "succes" | "neutral"; titel: string; tekst: string[] };

const TONE: Record<Boks["tone"], string> = {
  advarsel: "border-advarsel-kant bg-advarsel-bg text-advarsel-tekst",
  info: "border-info-kant bg-info-bg text-info-tekst",
  succes: "border-succes-kant bg-succes-bg text-succes-tekst",
  neutral: "border-kant-staerk bg-neutral-50 text-tekst",
};

const STRIPE = "Betalingen håndteres af vores betalingspartner Stripe.";

// TODO(indhold): gennemse teksterne til køber og sælger.
function statusBoks(sag: MinSag): Boks {
  const k = sag.erKoeber;
  switch (sag.status) {
    case "aaben":
      return k
        ? {
            tone: "advarsel",
            titel: "BidHamr ser på din sag",
            tekst: [
              "Pengene er frosset, mens sagen behandles, så sælgeren får dem ikke udbetalt imens.",
              "Du får besked, når sagen er afgjort. BidHamr kan skrive til dig under Beskeder, hvis vi har brug for mere.",
            ],
          }
        : {
            tone: "advarsel",
            titel: "Køberen har oprettet en sag",
            tekst: [
              "Pengene er frosset, mens BidHamr behandler sagen. Du får dem udbetalt, hvis sagen afgøres til din fordel.",
              "Du får besked, når sagen er afgjort. BidHamr kan skrive til dig under Beskeder, hvis vi har brug for mere.",
              STRIPE,
            ],
          };
    case "afventer_retur":
      return k
        ? {
            tone: "info",
            titel: "Send varen retur",
            tekst: [
              "Send varen retur – BidHamr betaler returfragten. Du får besked om label.",
              "Du får pengene tilbage, når returpakken er afleveret.",
            ],
          }
        : {
            tone: "info",
            titel: "Køberen sender varen retur",
            tekst: [
              "Køberen har fået medhold og sender varen retur til dig. BidHamr betaler returfragten.",
              "Pengene er stadig frosset, indtil returpakken er afleveret.",
            ],
          };
    case "afgjort_koeber":
      return k
        ? {
            tone: "succes",
            titel: "Du har fået medhold",
            tekst: [
              sag.beskyttelse
                ? "Du får pengene tilbage – alt undtagen BidHamr Beskyttelse."
                : "Du får pengene tilbage.",
              `${STRIPE} Det kan tage nogle dage, før pengene står på din konto.`,
            ],
          }
        : {
            tone: "neutral",
            titel: "Køberen har fået medhold",
            tekst: ["Køberen får pengene tilbage, og handlen er afsluttet."],
          };
    case "afgjort_saelger":
      return k
        ? {
            tone: "neutral",
            titel: "Sælgeren har fået medhold",
            tekst: ["Sagen er afgjort, og pengene udbetales til sælgeren."]
          }
        : {
            tone: "succes",
            titel: "Du har fået medhold",
            tekst: ["Pengene udbetales til dig.", STRIPE],
          };
    case "lukket":
      return {
        tone: "neutral",
        titel: "Sagen er lukket",
        tekst: ["Handlen fortsætter som normalt."],
      };
  }
}

export default function SagVisning({ sag, brugerId }: { sag: MinSag; brugerId: string }) {
  const boks = statusBoks(sag);
  return (
    <section aria-labelledby="sag-titel" className="rounded-2xl border border-kant bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="sag-titel" className="font-serif text-xl font-semibold text-tekst">
          Sag om handlen
        </h2>
        <SagStatusBadge status={sag.status} />
      </div>

      <div className={`mt-4 rounded-xl border p-4 text-sm ${TONE[boks.tone]}`}>
        <p className="font-semibold">{boks.titel}</p>
        {boks.tekst.map((t) => (
          <p key={t} className="mt-1">
            {t}
          </p>
        ))}
      </div>

      {sag.begrundelse && sag.status !== "aaben" && (
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-tekst">BidHamrs begrundelse</h3>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-tekst">{sag.begrundelse}</p>
        </div>
      )}

      <dl className="mt-5 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-tekst-svag">Hvad sagen drejer sig om</dt>
          <dd className="font-medium text-tekst">{SAG_TYPE_NAVN[sag.type]}</dd>
        </div>
        <div>
          <dt className="text-tekst-svag">Oprettet</dt>
          <dd className="font-medium text-tekst">{sagTid(sag.oprettetKl)}</dd>
        </div>
        {sag.afgjortKl && sag.status !== "aaben" && (
          <div>
            <dt className="text-tekst-svag">Afgjort</dt>
            <dd className="font-medium text-tekst">{sagTid(sag.afgjortKl)}</dd>
          </div>
        )}
        {sag.returAfleveretKl && (
          <div>
            <dt className="text-tekst-svag">Returpakke afleveret</dt>
            <dd className="font-medium text-tekst">{sagTid(sag.returAfleveretKl)}</dd>
          </div>
        )}
        {sag.genaabnetKl && (
          <div>
            <dt className="text-tekst-svag">Genåbnet</dt>
            <dd className="font-medium text-tekst">{sagTid(sag.genaabnetKl)}</dd>
          </div>
        )}
      </dl>
      {sag.beskyttelse && (
        <div className="mt-3">
          <BeskyttelseBadge />
        </div>
      )}

      <div className="mt-5">
        <h3 className="text-sm font-semibold text-tekst">Køberens beskrivelse</h3>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-tekst">{sag.beskrivelse}</p>
      </div>

      <div className="mt-5">
        <h3 className="mb-2 text-sm font-semibold text-tekst">Billeder ({sag.billeder.length})</h3>
        <SagBilleder billeder={sag.billeder} />
      </div>

      {sag.erKoeber && sag.status === "aaben" && (
        <div className="mt-5">
          <TilfoejSagBilleder
            sagId={sag.id}
            tradeId={sag.tradeId}
            koeberId={brugerId}
            pladsTilbage={SAG_MAKS_BILLEDER - sag.billeder.length}
          />
        </div>
      )}
    </section>
  );
}
