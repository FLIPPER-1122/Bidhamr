import Link from "next/link";
import { hentAntalVentendeAnker, hentSager, type SagListeRaekke } from "@/app/actions/adminSager";
import { SAG_TYPE_NAVN, adminSagSti } from "@/lib/sager";
import { BeskyttelseBadge, SagStatusBadge, sagTid } from "@/components/sager/visning";
import AdminSide from "@/components/admin/AdminSide";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import AdminFaner from "@/components/admin/AdminFaner";
import AdminFejl from "@/components/admin/AdminFejl";
import AdminTom from "@/components/admin/AdminTom";
import AdminBadge from "@/components/admin/AdminBadge";
import AdminSideskift from "@/components/admin/AdminSideskift";
import { hentStaffTal } from "@/lib/admin/taellere";
import { harMindstRolle, kraevSideRolle } from "@/lib/adminAuth";
import { erInhabil, hentSagTaget } from "@/lib/admin/sagTaget";
import TagSagKnap from "@/components/admin/sager/TagSagKnap";

// Sager oprettet af køberen. Åbne sager (venter på afgørelse) står øverst.
// Handler uden sag (hænger, manuel markering, fællesbesked) ligger under
// /admin/handler. Hurtigst: "Afgør næste" åbner den ældste åbne sag, og på
// sagen går "Løs og gå til næste sag" direkte videre.

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
  const { rolle, admin, userId } = await kraevSideRolle("medarbejder");
  const { vis, side: sideParam } = await searchParams;
  const fane: Fane = FANER.some((f) => f.key === vis) ? (vis as Fane) : "aabne";
  const side = Math.max(0, Math.min(1000, Number.parseInt(sideParam ?? "0", 10) || 0));

  const [res, ankerRes, tal] = await Promise.all([hentSager(fane, side), hentAntalVentendeAnker(), hentStaffTal()]);
  const antalAnker = "antal" in ankerRes ? ankerRes.antal : 0;
  const fejl = "fejl" in res ? res.fejl : null;
  const liste = "fejl" in res ? [] : res.sager;
  const flere = "fejl" in res ? false : res.flere;

  // Under "Åbne": sager, der venter på en afgørelse, før dem, der venter på retur.
  const sager =
    fane === "aabne"
      ? [...liste].sort((a, b) => Number(b.status === "aaben") - Number(a.status === "aaben"))
      : liste;
  const aabne = sager.filter((s) => s.status === "aaben" || s.status === "afventer_retur");
  const [taget, inhabilListe] = await Promise.all([
    hentSagTaget(admin, aabne.map((s) => s.id)),
    // "Tag sagen" skjules, hvor staff er inhabil (samme regel som databasen).
    Promise.all(aabne.map((s) => erInhabil(admin, userId, s.koeber.id, s.saelger.id))),
  ]);
  const inhabil = new Set(aabne.filter((_, i) => inhabilListe[i]).map((s) => s.id));
  // "Afgør næste sag" springer over sager, en kollega har taget.
  const ledig = (s: SagListeRaekke) => {
    const t = taget.get(s.id);
    return (!t || t.brugerId === userId) && !inhabil.has(s.id);
  };
  const foersteAabne = fane === "aabne"
      ? sager.find((s) => s.status === "aaben" && ledig(s))
      : fane === "anker"
        ? sager.find((s) => s.ankeVenter && ledig(s))
        : undefined;

  // ?side= er 0-baseret her (hentSager), så den bygges selv.
  const href = (f: Fane, s = 0) => `/admin/sager?vis=${f}${s > 0 ? `&side=${s}` : ""}`;

  return (
    <AdminSide>
      <AdminSideHoved
        titel="Sager"
        forklaring={
          <>
            Køberen har klaget over en handel. Læs sagen, og afgør hvem der har ret. Pengene er frosset, mens sagen er åben.
            Handler uden sag finder du under{" "}
            <Link href="/admin/handler" className="font-medium text-groen hover:underline">
              Handler
            </Link>
            .
          </>
        }
        handlinger={
          foersteAabne && (
            <Link href={adminSagSti(foersteAabne.id)} className="btn btn-primaer w-full sm:w-auto">
              {fane === "anker" ? "Afgør næste anke" : "Afgør næste sag"}
            </Link>
          )
        }
      />

      <AdminFaner
        label="Sager"
        aktiv={fane}
        faner={FANER.filter((f) => f.key !== "anker" || harMindstRolle(rolle, "admin") || antalAnker > 0).map((f) => ({
          id: f.key,
          label: f.label,
          href: href(f.key),
          antal: f.key === "aabne" ? tal.sager : f.key === "anker" ? antalAnker : undefined,
          tone: "gul" as const,
        }))}
      />

      {fejl ? (
        <AdminFejl hvad="Sagerne" detalje={fejl} />
      ) : sager.length === 0 ? (
        <AdminTom
          tekst={side > 0 ? "Der er ikke flere sager." : TOMT[fane]}
          link={fane !== "afgjorte" ? { href: href("afgjorte"), label: "Se afgjorte sager" } : undefined}
        />
      ) : (
        <ul className="overflow-hidden rounded-[14px] border border-admin-kant bg-white">
          {sager.map((s) => (
            <li key={s.id} className="flex flex-col border-t border-admin-kant first:border-t-0 sm:flex-row sm:items-center">
              <Link
                href={adminSagSti(s.id)}
                className={`flex min-w-0 flex-1 flex-col gap-1 px-4 py-4 transition-colors hover:bg-admin-bg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-groen sm:flex-row sm:items-center sm:gap-4 sm:px-5 ${
                  s.status === "aaben" || s.ankeVenter ? "bg-advarsel-bg/40" : ""
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <SagStatusBadge status={s.status} />
                    {s.beskyttelse && <BeskyttelseBadge />}
                    {s.ankeVenter && <AdminBadge tone="gul">Anke venter</AdminBadge>}
                  </div>
                  <p className="mt-1.5 min-w-0 break-words font-semibold text-tekst">{s.auktionTitel ?? "(slettet auktion)"}</p>
                  <p className="text-sm text-tekst-daempet">
                    {kortType(s)} · {s.koeber.navn ?? "Uden navn"} → {s.saelger.navn ?? "Uden navn"}
                  </p>
                </div>
                <p className="shrink-0 text-xs text-tekst-svag sm:text-right">
                  Oprettet {sagTid(s.oprettetKl)}
                  {s.afgjortKl && s.status !== "aaben" && <span className="block">Afgjort {sagTid(s.afgjortKl)}</span>}
                  <span className="block">
                    {s.antalBilleder} {s.antalBilleder === 1 ? "billede" : "billeder"}
                  </span>
                </p>
              </Link>
              {(s.status === "aaben" || s.status === "afventer_retur") && (
                <div className="px-4 pb-4 sm:px-5 sm:py-4">
                  <TagSagKnap sagId={s.id} taget={taget.get(s.id) ?? null} mig={userId} inhabil={inhabil.has(s.id)} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <AdminSideskift side={side + 1} harNaeste={flere} lavHref={(s) => href(fane, s - 1)} />
    </AdminSide>
  );
}
