import Link from "next/link";
import { kraevErhvervSide } from "@/lib/adminAuth";
import { hentFirmaer } from "@/app/actions/adminErhverv";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import ErhvervFaner, { dato } from "@/components/admin/erhverv/ErhvervFaner";
import { ADMIN_ERHVERV as A, ADMIN_ERHVERV_EKSTRA as X } from "@/lib/tekster/erhverv";
import { ABONNEMENT_STATUS_NAVN } from "@/lib/erhverv/regler";
import AdminSide from "@/components/admin/AdminSide";

export const metadata = { title: "Firmaer" };

export default async function ErhvervFirmaerSide() {
  await kraevErhvervSide();
  const res = await hentFirmaer();
  const fejl = "fejl" in res ? res.fejl : null;
  const firmaer = "fejl" in res ? [] : res.firmaer;

  return (
    <AdminSide>
      <AdminSideHoved
        titel="Firmaer"
        forklaring={X.forklaring}
        hoejre={<span className="text-sm text-tekst-svag">{X.antalFirmaer(firmaer.length)}</span>}
      />
      <ErhvervFaner aktiv="firmaer" />
      <h2 className="font-sans text-lg font-semibold text-tekst">{A.firmaer.titel}</h2>

      {fejl && (
        <p role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          {fejl}
        </p>
      )}
      {!fejl && firmaer.length === 0 ? (
        <p className="rounded-[14px] border border-admin-kant bg-white p-8 text-center text-tekst-svag">{A.firmaer.tom}</p>
      ) : (
        <ul className="divide-y divide-admin-kant overflow-hidden rounded-[14px] border border-admin-kant bg-white">
          {firmaer.map((f) => (
            <li key={f.id}>
              <Link
                href={`/admin/erhverv/firmaer/${f.id}`}
                className="flex flex-col gap-1 px-5 py-4 hover:bg-neutral-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-groen sm:flex-row sm:items-center sm:gap-4"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-semibold text-tekst">
                    <span className="break-words">{f.firmanavn}</span>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                        f.abonnement_status === "aktiv" ? "bg-succes-bg text-succes-tekst" : "bg-advarsel-bg text-advarsel-tekst"
                      }`}
                    >
                      {ABONNEMENT_STATUS_NAVN[f.abonnement_status] ?? f.abonnement_status}
                    </span>
                    {f.afventende_opgradering && (
                      <span className="rounded-full bg-info-bg px-2.5 py-0.5 text-xs font-semibold text-info-tekst">
                        {A.firmaer.abonnementAfventerBetaling}
                      </span>
                    )}
                    {!f.har_logget_ind && (
                      <span className="rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs font-medium text-tekst">
                        {X.ikkeLoggetInd}
                      </span>
                    )}
                  </p>
                  <p className="text-sm text-tekst-daempet">
                    {A.firmaer.kolonneCvr} {f.cvr} · {A.firmaer.kolonnePakke}: {f.pakke?.navn ?? "–"} · {X.aktiveAuktioner}: {f.aktive_auktioner}
                  </p>
                </div>
                <p className="shrink-0 text-sm text-tekst-svag">{dato(f.oprettet_kl)}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </AdminSide>
  );
}
