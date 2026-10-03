import Link from "next/link";
import { hentAntalVentendeAnker, hentSager, type SagListeRaekke } from "@/app/actions/adminSager";
import { SAG_TYPE_NAVN, adminSagSti } from "@/lib/sager";
import { BeskyttelseBadge, SagStatusBadge, sagTid } from "@/components/sager/visning";

// Sager oprettet af køberen. Åbne sager (venter på afgørelse) står øverst.
// Handler uden sag (hænger, manuel markering, fællesbesked) ligger under
// /admin/handler.

const FANER = [
  { key: "aabne", label: "Åbne" },
  { key: "anker", label: "Anker" },
  { key: "afventer_retur", label: "Afventer retur" },
  { key: "afgjorte", label: "Afgjorte" },
] as const;
type Fane = (typeof FANER)[number]["key"];

const TOMT: Record<Fane, string> = {
  aabne: "Ingen åbne sager lige nu.",
  anker: "Ingen anker venter lige nu.",
  afventer_retur: "Ingen sager venter på en returpakke.",
  afgjorte: "Ingen afgjorte sager endnu.",
};

function kortType(s: SagListeRaekke) {
  return SAG_TYPE_NAVN[s.type].split(" (")[0];
}

export default async function AdminSager({
  searchParams,
}: {
  searchParams: Promise<{ vis?: string; side?: string }>;
}) {
  const { vis, side: sideParam } = await searchParams;
  const fane: Fane = FANER.some((f) => f.key === vis) ? (vis as Fane) : "aabne";
  const side = Math.max(0, Math.min(1000, Number.parseInt(sideParam ?? "0", 10) || 0));

  const [res, ankerRes] = await Promise.all([hentSager(fane, side), hentAntalVentendeAnker()]);
  const antalAnker = "antal" in ankerRes ? ankerRes.antal : 0;
  const fejl = "fejl" in res ? res.fejl : null;
  const liste = "fejl" in res ? [] : res.sager;
  const flere = "fejl" in res ? false : res.flere;

  // Under "Åbne": sager, der venter på en afgørelse, før dem, der venter på retur.
  const sager =
    fane === "aabne"
      ? [...liste].sort((a, b) => Number(b.status === "aaben") - Number(a.status === "aaben"))
      : liste;

  function href(f: Fane, s = 0) {
    const p = new URLSearchParams({ vis: f });
    if (s > 0) p.set("side", String(s));
    return `/admin/sager?${p}`;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900">Sager</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Sager oprettet af køberen. Pengene er frosset, mens en sag er åben. Handler uden sag finder du under{" "}
          <Link href="/admin/handler" className="font-medium text-groen hover:underline">
            Handler
          </Link>
          .
        </p>
      </div>

      <nav aria-label="Filtrér sager" className="flex flex-wrap gap-2">
        {FANER.map((f) => {
          const aktiv = f.key === fane;
          return (
            <Link
              key={f.key}
              href={href(f.key)}
              aria-current={aktiv ? "page" : undefined}
              className={`inline-flex min-h-10 items-center rounded-full px-4 text-sm font-medium transition-colors ${
                aktiv
                  ? "bg-orange-knap text-white"
                  : "border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-100"
              }`}
            >
              {f.label}
              {f.key === "anker" && antalAnker > 0 && (
                <span
                  className={`ml-2 rounded-full px-2 py-0.5 text-xs font-semibold ${
                    aktiv ? "bg-white text-orange-knap" : "bg-orange-knap text-white"
                  }`}
                >
                  {antalAnker}
                  <span className="sr-only"> anker venter</span>
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {fejl ? (
        <p role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg px-5 py-4 text-sm text-fejl-tekst">
          Sagerne kunne ikke hentes: {fejl}
        </p>
      ) : sager.length === 0 ? (
        <div className="rounded-xl border border-neutral-200 bg-white px-5 py-10 text-center text-sm text-neutral-500">
          {side > 0 ? "Der er ikke flere sager." : TOMT[fane]}
        </div>
      ) : (
        <ul className="divide-y divide-neutral-100 overflow-hidden rounded-xl border border-neutral-200 bg-white">
          {sager.map((s) => (
            <li key={s.id}>
              <Link
                href={adminSagSti(s.id)}
                className={`block px-4 py-4 transition-colors hover:bg-neutral-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-groen sm:px-5 ${
                  s.status === "aaben" || s.ankeVenter ? "bg-advarsel-bg/40" : ""
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <SagStatusBadge status={s.status} />
                  {s.beskyttelse && <BeskyttelseBadge />}
                  {s.ankeVenter && (
                    <span className="inline-block rounded-full border border-advarsel-kant bg-advarsel-bg px-2.5 py-1 text-xs font-semibold text-advarsel-tekst">
                      Anke venter
                    </span>
                  )}
                  <span className="min-w-0 break-words font-semibold text-neutral-900">
                    {s.auktionTitel ?? "(slettet auktion)"}
                  </span>
                </div>
                <p className="mt-1 text-sm text-neutral-700">{kortType(s)}</p>
                <p className="mt-1 text-sm text-neutral-500">
                  Køber: <span className="text-neutral-700">{s.koeber.navn ?? "Uden navn"}</span>
                  {" · "}Sælger: <span className="text-neutral-700">{s.saelger.navn ?? "Uden navn"}</span>
                </p>
                <p className="mt-1 text-xs text-neutral-500">
                  Oprettet {sagTid(s.oprettetKl)}
                  {s.afgjortKl && s.status !== "aaben" && ` · Afgjort ${sagTid(s.afgjortKl)}`}
                  {` · ${s.antalBilleder} ${s.antalBilleder === 1 ? "billede" : "billeder"}`}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {(side > 0 || flere) && (
        <div className="flex items-center justify-between gap-3">
          {side > 0 ? (
            <Link href={href(fane, side - 1)} className="btn btn-sekundaer btn-lille">
              Forrige
            </Link>
          ) : (
            <span />
          )}
          <span className="text-sm text-neutral-500">Side {side + 1}</span>
          {flere ? (
            <Link href={href(fane, side + 1)} className="btn btn-sekundaer btn-lille">
              Næste
            </Link>
          ) : (
            <span />
          )}
        </div>
      )}
    </div>
  );
}
