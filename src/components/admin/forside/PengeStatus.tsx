import Link from "next/link";
import type { Pengesikkerhed } from "@/app/actions/adminPengesikkerhed";
import type { Pengeoverblik } from "@/lib/admin/pengeOekonomi";

// Pengestatus på forsiden - KUN chef (siden henter kun data for chefen, og
// hentPengesikkerhed() tjekker rollen igen). Data fra sikkerhedsnet A:
// nødstop, udbetalinger til godkendelse og frosne sælgere - og fra
// sikkerhedsnet B (admin_penge_overblik): "Hos Stripe nu" (seneste kendte
// saldo, ikke hentet live ved hver visning) og "Hos sælgerne".
// Selve nødstop-knappen ligger kun på Penge - en farlig handling skal ikke
// ligge ét klik fra startsiden.

const kr = (oere: number) =>
  (oere / 100).toLocaleString("da-DK", { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + " kr.";

function Kort({ titel, tal, under }: { titel: string; tal: string; under: string }) {
  return (
    <div className="rounded-xl border border-admin-kant bg-white px-4 py-3.5">
      <small className="block text-[12.5px] text-tekst-svag">{titel}</small>
      <b className="mt-0.5 block text-[22px] font-bold tabular-nums tracking-tight text-tekst">{tal}</b>
      <em className="text-[12.5px] not-italic text-tekst-daempet">{under}</em>
    </div>
  );
}

const TZ = "Europe/Copenhagen";

export default function PengeStatus({ penge, overblik }: { penge: Pengesikkerhed; overblik: Pengeoverblik | null }) {
  const snap = overblik?.snapshot ?? null;
  const n = penge.noedstop;
  const stoppet = n.udbetalingerStoppet || n.nyeBetalingerStoppet;
  const sum = penge.godkendelser.reduce((s, g) => s + g.udbetalingOere, 0);
  return (
    <section aria-labelledby="forside-penge" className="space-y-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="forside-penge" className="text-[13px] font-semibold uppercase tracking-[0.06em] text-tekst-svag">
          Penge
        </h2>
        <Link href="/admin/penge" className="text-[13.5px] font-semibold text-groen hover:underline">
          Åbn Penge →
        </Link>
      </div>
      <div className="grid grid-cols-1 gap-2.5 min-[420px]:grid-cols-2 lg:grid-cols-3">
        {snap && (
          <Kort
            titel="Hos Stripe nu"
            tal={kr(snap.tilgaengelig_oere)}
            under={`tilgængeligt · ${kr(snap.afventer_oere)} afventer · opdateret ${new Date(snap.kl).toLocaleString("da-DK", { dateStyle: "short", timeStyle: "short", timeZone: TZ })}`}
          />
        )}
        {overblik && (
          <Kort
            titel="Hos sælgerne (holdes)"
            tal={kr(overblik.saelgere.oere)}
            under={`${overblik.saelgere.antal_handler} igangværende ${overblik.saelgere.antal_handler === 1 ? "handel" : "handler"}`}
          />
        )}
        <Kort
          titel="Til godkendelse"
          tal={penge.godkendelser.length ? `${penge.godkendelser.length} · ${kr(sum)}` : "0"}
          under="udbetalinger over beløbsgrænsen"
        />
        <Kort
          titel="Frosne sælgere"
          tal={String(penge.frosne.length)}
          under={penge.frosne.length ? "ingen udbetalinger til dem" : "ingen er frosset"}
        />
        <Kort
          titel="Nødstop"
          tal={stoppet ? "TIL" : "Fra"}
          under={
            stoppet
              ? [n.udbetalingerStoppet && "udbetalinger", n.nyeBetalingerStoppet && "nye betalinger"].filter(Boolean).join(" og ") + " stoppet"
              : "knappen ligger på Penge"
          }
        />
      </div>
    </section>
  );
}
