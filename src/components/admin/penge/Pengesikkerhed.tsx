import Link from "next/link";
import ConfirmDialog from "@/components/admin/ConfirmDialog";
import {
  annullerAabneBetalingerIgen,
  godkendUdbetaling,
  hentPengesikkerhed,
  ophaevFrysning,
  saetNoedstop,
} from "@/app/actions/adminPengesikkerhed";

// Admin → Penge (kun chef): nødstop, udbetalinger, der venter på chefens
// godkendelse (købers samlede betaling 10.000 kr. eller mere, uanset hvordan
// pengene blev frigivet), og frosne sælgere (sikkerhedsnet A).

const kr = (oere: number) =>
  (oere / 100).toLocaleString("da-DK", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " kr";

const tid = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("da-DK", { timeZone: "Europe/Copenhagen", dateStyle: "short", timeStyle: "short" })
    : "–";

const FROSSET_GRUND: Record<string, string> = {
  fremmed_udbetaling: "Udbetaling fra sælgerens Stripe-konto, som BidHamr ikke har lavet",
  udbetalingsplan: "Sælgerkontoens udbetalingsplan var ikke manuel",
  manuel: "Frosset af chefen (se begrundelsen i medarbejder-loggen)",
};

const ROED_KNAP =
  "inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-700 transition-colors";
const NEUTRAL_KNAP =
  "inline-flex items-center gap-2 rounded-lg border border-neutral-300 bg-white px-4 py-2.5 text-sm font-semibold text-neutral-800 hover:bg-neutral-50 transition-colors";

function NoedstopLinje({
  hvad,
  titel,
  forklaring,
  stoppet,
  aarsag,
  kl,
}: {
  hvad: "udbetalinger" | "nye_betalinger";
  titel: string;
  forklaring: string;
  stoppet: boolean;
  aarsag: string | null;
  kl: string | null;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-neutral-100 py-3 last:border-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="font-medium text-neutral-900">
          {titel}:{" "}
          {stoppet ? <span className="font-bold text-red-700">STOPPET</span> : <span className="text-green-700">kører</span>}
        </p>
        <p className="text-xs text-neutral-500">{forklaring}</p>
        {stoppet && (
          <p className="mt-1 text-sm text-red-700">
            Stoppet {tid(kl)}{aarsag ? ` – ${aarsag}` : ""}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
      {stoppet && hvad === "nye_betalinger" && (
        <ConfirmDialog
          triggerLabel="Annullér åbne betalinger"
          triggerClassName={NEUTRAL_KNAP}
          title="Annullér åbne betalinger igen?"
          description="Åbne betalinger (checkout-sider, der står åbne) annulleres hos Stripe, højst 500 ad gangen. Betalinger, der allerede er sendt til banken, røres ikke."
          confirmLabel="Annullér"
          action={annullerAabneBetalingerIgen}
          hiddenFields={{}}
          kvittering="Åbne betalinger er annulleret"
        />
      )}
      <ConfirmDialog
        triggerLabel={stoppet ? "Genoptag" : "Stop"}
        triggerClassName={stoppet ? NEUTRAL_KNAP : ROED_KNAP}
        title={stoppet ? `Genoptag ${titel.toLowerCase()}?` : `Stop ${titel.toLowerCase()}?`}
        description={
          stoppet
            ? "Alt kører som normalt igen med det samme."
            : `${forklaring} Refusioner til køberne kører videre. Stoppet gælder, til du genoptager.`
        }
        confirmLabel={stoppet ? "Genoptag" : "Stop nu"}
        action={saetNoedstop}
        hiddenFields={{ hvad, stop: stoppet ? "nej" : "ja" }}
        aarsagField={{ name: "aarsag", label: "Begrundelse", placeholder: "Hvorfor?", required: true }}
        kvittering={stoppet ? "Genoptaget" : "Stoppet"}
      />
      </div>
    </div>
  );
}

export default async function Pengesikkerhed() {
  const r = await hentPengesikkerhed();
  if ("fejl" in r) {
    return <p className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{r.fejl}</p>;
  }
  const n = r.noedstop;
  return (
    <section className="rounded-xl border border-neutral-200 bg-white">
      <div className="border-b border-neutral-100 px-4 py-3 sm:px-5">
        <h2 className="font-semibold text-neutral-900">Sikkerhed og nødstop</h2>
        <p className="mt-0.5 text-xs text-neutral-500">Kun chefen. Alt logges i medarbejder-loggen.</p>
      </div>
      <div className="px-4 py-2 sm:px-5">
        <NoedstopLinje
          hvad="udbetalinger"
          titel="Udbetalinger"
          forklaring="Når udbetalinger er stoppet, sendes ingen penge fra sælgernes Stripe-konti til deres bank. En udbetaling, der allerede er oprettet hos Stripe, stoppes ikke herfra - den kan annulleres i Stripe, så længe den ikke er sendt til banken."
          stoppet={n.udbetalingerStoppet}
          aarsag={n.udbetalingerAarsag}
          kl={n.udbetalingerKl}
        />
        <NoedstopLinje
          hvad="nye_betalinger"
          titel="Nye betalinger"
          forklaring="Når nye betalinger er stoppet, kan købere ikke betale for deres handler. Betalingsfristerne står stille: ingen handel annulleres for manglende betaling, og når du genoptager, forlænges køberens frist med stoppets varighed (mindst 24 timer), og køberen får besked. Åbne betalinger annulleres hos Stripe, men en betaling, der allerede er sendt til banken (fx MobilePay under behandling), kan nå at gå igennem - den registreres som normalt."
          stoppet={n.nyeBetalingerStoppet}
          aarsag={n.nyeBetalingerAarsag}
          kl={n.nyeBetalingerKl}
        />
      </div>

      <div className="border-t border-neutral-100 px-4 py-3 sm:px-5">
        <h3 className="text-sm font-semibold text-neutral-900">Udbetalinger, der venter på din godkendelse</h3>
        <p className="mt-0.5 text-xs text-neutral-500">
          Når køberen har betalt 10.000 kr. eller mere, kræver udbetalingen din godkendelse – også når pengene er frigivet via en sag. Du kan godkende, når din godkendelse er det eneste, der mangler. Åbnes der senere en sag eller anke på handlen, skal du godkende igen.
        </p>
        {r.godkendelser.length === 0 ? (
          <p className="mt-1 text-sm text-neutral-500">Ingen.</p>
        ) : (
          <ul className="mt-2 divide-y divide-neutral-100">
            {r.godkendelser.map((g) => (
              <li key={g.betalingId} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 text-sm">
                  <Link href={`/admin/handler/${g.tradeId}`} className="font-medium text-neutral-900 underline">
                    {g.titel ?? "Handel"}
                  </Link>
                  <span className="text-neutral-600">
                    {" "}· {g.saelger ?? "Sælger"} · køber betalte {kr(g.totalOere)} · til sælger {kr(g.udbetalingOere)} · frigivet {tid(g.frigivetKl)}
                  </span>
                </div>
                <ConfirmDialog
                  triggerLabel="Godkend udbetaling"
                  triggerClassName={NEUTRAL_KNAP}
                  title="Godkend udbetalingen?"
                  description={`${kr(g.udbetalingOere)} udbetales fra sælgerens Stripe-konto til banken, når alle andre regler er opfyldt.`}
                  confirmLabel="Godkend"
                  action={godkendUdbetaling}
                  hiddenFields={{ betalingId: g.betalingId }}
                  aarsagField={{ name: "note", label: "Hvad har du kontrolleret?", placeholder: "Fx handlen og sælgerens konto", required: true }}
                  kvittering="Udbetalingen er godkendt"
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-neutral-100 px-4 py-3 sm:px-5">
        <h3 className="text-sm font-semibold text-neutral-900">Frosne sælgere</h3>
        {r.frosne.length === 0 ? (
          <p className="mt-1 text-sm text-neutral-500">Ingen.</p>
        ) : (
          <ul className="mt-2 divide-y divide-neutral-100">
            {r.frosne.map((f) => (
              <li key={f.brugerId} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 text-sm">
                  <Link href={`/admin/brugere/${f.brugerId}`} className="font-medium text-neutral-900 underline">
                    {f.navn ?? "Sælger"}
                  </Link>
                  <span className="block text-neutral-600">
                    {FROSSET_GRUND[f.grund ?? ""] ?? "Frosset"} · siden {tid(f.udbetalingFrossetKl)}
                    {f.salgFrosset ? " · kan heller ikke sælge" : ""}
                  </span>
                </div>
                <ConfirmDialog
                  triggerLabel="Ophæv frysning"
                  triggerClassName={NEUTRAL_KNAP}
                  title="Ophæv frysningen?"
                  description="Sælgeren kan igen få udbetalinger (og sælge). Markeringerne på sælgerens handler lukker du selv under Betalinger."
                  confirmLabel="Ophæv"
                  action={ophaevFrysning}
                  hiddenFields={{ brugerId: f.brugerId }}
                  aarsagField={{ name: "note", label: "Hvad har du kontrolleret?", placeholder: "Fx kontoen og saldoen i Stripe", required: true }}
                  kvittering="Frysningen er ophævet"
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
