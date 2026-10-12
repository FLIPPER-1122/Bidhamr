import Link from "next/link";
import { kraevErhvervSide } from "@/lib/adminAuth";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import ErhvervFaner from "@/components/admin/erhverv/ErhvervFaner";
import { Frist, Pille, tid } from "@/components/admin/dsa/DsaDele";
import { FIRMA_KLAGER_SIDE, hentFirmaDsaKlager, hentFirmaFor, type FirmaKlageStatus } from "@/lib/dsa/firmaKlager";
import { ERHVERV_DSA_KLAGER as T } from "@/lib/tekster/erhvervDsaKlager";
import AdminSide from "@/components/admin/AdminSide";

// Admin → Erhverv → Firmaets klager: DSA-klager over suspension og
// lukning af en firmakonto. Kun chef og saelger (kraevErhvervSide). Klagen
// læses og afgøres på /admin/erhverv/dsa-klager/[id].

export const dynamic = "force-dynamic";

export const metadata = { title: "Firmaers klager (DSA)" };

const MAKS = 200;

export default async function ErhvervDsaKlagerSide({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; antal?: string }>;
}) {
  const { admin } = await kraevErhvervSide();
  const sp = await searchParams;
  const status: FirmaKlageStatus = sp.status === "afgjort" ? "afgjort" : "afventer";
  const raaAntal = Number(sp.antal);
  const antal = Number.isInteger(raaAntal) && raaAntal > FIRMA_KLAGER_SIDE ? Math.min(raaAntal, MAKS) : FIRMA_KLAGER_SIDE;

  const res = await hentFirmaDsaKlager(admin, status, antal);
  const fejl = "fejl" in res;
  const klager = "fejl" in res ? [] : res.klager;
  const flere = "fejl" in res ? false : res.flere && antal < MAKS;

  const firmaer = await hentFirmaFor(admin, [...new Set(klager.map((k) => k.afg.bruger_id))]);
  const afgjortAf = [...new Set(klager.map((k) => k.afgjort_af).filter((x): x is string => !!x))];
  const { data: staff } = afgjortAf.length
    ? await admin.from("users").select("id, navn").in("id", afgjortAf)
    : { data: [] as { id: string; navn: string | null }[] };
  const navne = new Map(((staff ?? []) as { id: string; navn: string | null }[]).map((u) => [u.id, u.navn ?? "Uden navn"]));

  const filterHref = (s: FirmaKlageStatus) => (s === "afventer" ? "/admin/erhverv/dsa-klager" : "/admin/erhverv/dsa-klager?status=afgjort");
  const flereHref = `${filterHref(status)}${status === "afgjort" ? "&" : "?"}antal=${antal + FIRMA_KLAGER_SIDE}`;

  return (
    <AdminSide>
      <AdminSideHoved titel="Firmaers klager (DSA)" forklaring={T.forklaring} />
      <ErhvervFaner aktiv="dsa-klager" />

      <div>
        <h2 className="font-sans text-lg font-semibold text-tekst">{T.titel}</h2>
      </div>

      <nav aria-label="Filter" className="flex flex-wrap gap-2">
        {(["afventer", "afgjort"] as const).map((s) => (
          <Link
            key={s}
            href={filterHref(s)}
            aria-current={status === s ? "page" : undefined}
            className={`inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-medium ${
              status === s ? "border-groen bg-groen text-white" : "border-neutral-300 bg-white text-tekst hover:border-groen"
            }`}
          >
            {T.filter[s]}
          </Link>
        ))}
      </nav>

      {fejl && (
        <p role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          {T.fejl}
        </p>
      )}

      {!fejl && klager.length === 0 ? (
        <p className="rounded-[14px] border border-admin-kant bg-white p-8 text-center text-tekst-svag">{T.tom[status]}</p>
      ) : (
        <ul className="divide-y divide-admin-kant overflow-hidden rounded-[14px] border border-admin-kant bg-white">
          {klager.map((k) => {
            const firma = firmaer.get(k.afg.bruger_id);
            const lukket = k.afg.handling === "konto_lukket";
            return (
              <li key={k.id}>
                <Link
                  href={`/admin/erhverv/dsa-klager/${k.id}`}
                  className="flex min-h-11 flex-col gap-1.5 px-5 py-4 hover:bg-neutral-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-groen sm:flex-row sm:items-center sm:gap-4"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-semibold text-tekst">
                      <span>{k.sagsnummer}</span>
                      <span className="break-words">{firma?.firmanavn ?? "Firma"}</span>
                      <Pille farve={lukket ? "orange" : "blaa"}>
                        {lukket ? T.lukket : T.suspenderet}
                        {!lukket && ` · ${k.afg.varighed_til ? T.til(tid(k.afg.varighed_til)) : T.permanent}`}
                      </Pille>
                      {k.udfald && (
                        <Pille farve={k.udfald === "medhold" ? "groen" : "neutral"}>
                          {k.udfald === "medhold" ? T.medhold : T.fastholdt}
                        </Pille>
                      )}
                    </p>
                    <p className="mt-0.5 line-clamp-2 break-words text-sm text-tekst-daempet">{k.begrundelse}</p>
                    {k.afgjort_kl && (
                      <p className="mt-0.5 text-xs text-tekst-svag">
                        {T.afgjortAf(navne.get(k.afgjort_af ?? "") ?? "–", tid(k.afgjort_kl))}
                      </p>
                    )}
                  </div>
                  <div className="shrink-0 text-sm text-tekst-svag">
                    {status === "afventer" ? <Frist iso={k.frist_kl} /> : tid(k.oprettet_kl)}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {flere && (
        <div className="flex justify-center">
          <Link
            href={flereHref}
            scroll={false}
            className="inline-flex min-h-11 items-center rounded-full border border-neutral-300 bg-white px-5 text-sm font-medium text-tekst hover:border-groen"
          >
            {T.visFlere}
          </Link>
        </div>
      )}
    </AdminSide>
  );
}
