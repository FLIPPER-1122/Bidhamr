// Firmakontoen under Admin → Erhverv → Firmaer → [firma]: luk, suspendér,
// ophæv suspension og forslag om lukning. Chef og sælger-rollen
// (assertErhverv i server actions; databasen tjekker igen). Server component -
// knapperne er ConfirmDialog (klient) med de samme DSA-felter som resten af
// admin.
import ConfirmDialog from "@/components/admin/ConfirmDialog";
import { indgrebFelter } from "@/components/admin/indgrebFelter";
import {
  afvisFirmaLukning,
  godkendFirmaLukning,
  lukFirmakonto,
  ophaevFirmaSuspension,
  suspenderFirmakonto,
} from "@/app/actions/adminErhvervFirmaKonto";
import { FIRMA_KONTO as T } from "@/lib/tekster/erhvervKlager";

export type FirmaKontoTilstand = {
  suspenderet: boolean;
  suspenderet_til: string | null;
  suspenderet_aarsag: string | null;
  konto_lukket_kl: string | null;
};

export type FirmaLukningForslag = { id: string; advarsler_antal: number } | null;

const KNAP = "inline-flex min-h-11 items-center justify-center rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors";
const FARE = `${KNAP} bg-red-600 text-white hover:bg-red-700`;
const SEKUNDAER = `${KNAP} border border-neutral-300 bg-white text-neutral-800 hover:bg-neutral-50`;
const GROEN = `${KNAP} bg-green-100 text-green-800 hover:bg-green-200`;

const dato = (iso: string) =>
  new Date(iso).toLocaleString("da-DK", { timeZone: "Europe/Copenhagen", dateStyle: "medium", timeStyle: "short" });

export default function FirmaKontoSektion({
  firmaId,
  konto,
  forslag,
}: {
  firmaId: string;
  konto: FirmaKontoTilstand;
  forslag: FirmaLukningForslag;
}) {
  const lukket = !!konto.konto_lukket_kl;
  const aktivSuspension =
    konto.suspenderet && (konto.suspenderet_til === null || new Date(konto.suspenderet_til) > new Date());
  const status = lukket
    ? T.lukket(dato(konto.konto_lukket_kl!))
    : aktivSuspension
      ? konto.suspenderet_til
        ? T.suspenderetTil(dato(konto.suspenderet_til))
        : T.suspenderetPermanent
      : T.aktiv;

  return (
    <section id="firmakonto" aria-labelledby="firmakonto-titel" className="scroll-mt-24 rounded-xl border border-neutral-200 bg-white p-5">
      <h2 id="firmakonto-titel" className="text-lg font-semibold text-neutral-900">
        {T.titel}
      </h2>
      <p className="mt-1 text-sm text-neutral-600">{T.forklaring}</p>
      <dl className="mt-3">
        <dt className="text-xs font-medium text-neutral-500">{T.status}</dt>
        <dd className={`text-[15px] ${lukket || aktivSuspension ? "font-semibold text-red-700" : "text-neutral-900"}`}>{status}</dd>
        {!lukket && aktivSuspension && konto.suspenderet_aarsag && (
          <>
            <dt className="mt-2 text-xs font-medium text-neutral-500">{T.aarsag}</dt>
            <dd className="break-words text-[15px] text-neutral-900">{konto.suspenderet_aarsag}</dd>
          </>
        )}
      </dl>

      {forslag && !lukket && (
        <div className="mt-4 space-y-3 rounded-xl border border-red-200 bg-red-50 p-4">
          <p className="text-sm font-semibold text-red-800">{T.forslagTitel(forslag.advarsler_antal)}</p>
          <p className="text-sm text-red-800">{T.forslagTekst}</p>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <ConfirmDialog
              triggerLabel={T.knapGodkend}
              triggerClassName={FARE}
              title={T.godkendTitel}
              description={T.godkendTekst}
              confirmLabel={T.knapGodkend}
              action={godkendFirmaLukning}
              hiddenFields={{ firmaId, forslagId: forslag.id }}
              tekstFelter={[{ name: "note", label: T.godkendNote, required: false, maxLength: 2000 }]}
            />
            <ConfirmDialog
              triggerLabel={T.knapAfvis}
              triggerClassName={SEKUNDAER}
              title={T.afvisTitel}
              description={T.afvisTekst}
              confirmLabel={T.knapAfvis}
              action={afvisFirmaLukning}
              hiddenFields={{ firmaId, forslagId: forslag.id }}
              tekstFelter={[{ name: "begrundelse", label: T.afvisBegrundelse, required: true, maxLength: 2000 }]}
            />
          </div>
        </div>
      )}

      {!lukket && (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {aktivSuspension ? (
            <ConfirmDialog
              triggerLabel={T.knapOphaev}
              triggerClassName={GROEN}
              title={T.ophaevTitel}
              description={T.ophaevTekst}
              confirmLabel={T.ophaevBekraeft}
              action={ophaevFirmaSuspension}
              hiddenFields={{ firmaId }}
            />
          ) : (
            <ConfirmDialog
              triggerLabel={T.knapSuspender}
              triggerClassName={SEKUNDAER}
              title={T.suspenderTitel}
              description={T.suspenderTekst}
              confirmLabel={T.suspenderBekraeft}
              action={suspenderFirmakonto}
              hiddenFields={{ firmaId }}
              varighedField
              {...indgrebFelter({ faktaPlaceholder: T.suspenderPladsholder })}
            />
          )}
          <ConfirmDialog
            triggerLabel={T.knapLuk}
            triggerClassName={FARE}
            title={T.lukTitel}
            description={T.lukTekst}
            confirmLabel={T.lukBekraeft}
            action={lukFirmakonto}
            hiddenFields={{ firmaId }}
            {...indgrebFelter({ faktaPlaceholder: T.lukPladsholder })}
          />
        </div>
      )}
    </section>
  );
}
