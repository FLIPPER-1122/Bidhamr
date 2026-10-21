import Link from "next/link";
import AdminSide from "@/components/admin/AdminSide";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import AdminFilterChips from "@/components/admin/AdminFilterChips";
import AdminFejl from "@/components/admin/AdminFejl";
import AdminTom from "@/components/admin/AdminTom";
import AdminBadge from "@/components/admin/AdminBadge";
import AdminSideskift, { adminHref, laesSide } from "@/components/admin/AdminSideskift";
import { EkstraFragtStatusBadge, oereKr } from "@/components/admin/ekstraFragt/visning";
import { hentStaffTal } from "@/lib/admin/taellere";
import { kraevSideRolle } from "@/lib/adminAuth";
import type { EkstraFragtStatus } from "@/lib/ekstraFragt/tekster";
import { ekstraFragtTid, maalingTekst, valgtStoerrelseNavn } from "@/lib/ekstraFragt/visning";
import { transportoerNavn } from "@/lib/fragt/types";

// Ekstra fragt ved for lille pakkestørrelse (ROADMAP-BESLUTNINGER, Filip 21.
// okt. 2026). Staff registrerer regningen på handlens side; her følger man
// med, afgør indsigelser og frafalder. Indsigelser står som rødt filter.

export const metadata = { title: "Ekstra fragt" };

const PR_SIDE = 20;

const FILTRE = [
  { id: "aabne", label: "Åbne" },
  { id: "indsigelse", label: "Indsigelse" },
  { id: "tabt", label: "Tabt bankindsigelse" },
  { id: "spaerret", label: "Spærret" },
  { id: "afventer", label: "Afventer betaling" },
  { id: "betalt", label: "Betalt" },
  { id: "frafaldet", label: "Frafaldet" },
  { id: "alle", label: "Alle" },
] as const;
type Filter = (typeof FILTRE)[number]["id"];

const TOMT: Partial<Record<Filter, string>> = {
  aabne: "Ingen åbne regninger for ekstra fragt.",
  indsigelse: "Ingen indsigelser venter.",
  tabt: "Ingen betalinger er tilbageført efter en tabt bankindsigelse.",
  spaerret: "Ingen sælgere er spærret for ubetalt ekstra fragt.",
  afventer: "Ingen regninger afventer betaling.",
};

type Raekke = {
  id: string;
  trade_id: string;
  saelger_id: string;
  transportoer: string | null;
  valgt_stoerrelse: string;
  maalt_stoerrelse: string | null;
  maalt_vaegt_gram: number | null;
  maalt_maal: string | null;
  beloeb_oere: number;
  status: EkstraFragtStatus;
  frist: string;
  oprettet_kl: string;
  indsigelse_kl: string | null;
  kraever_opmaerksomhed: boolean;
  bankindsigelse_tabt_kl: string | null;
};

export default async function AdminEkstraFragt({
  searchParams,
}: {
  searchParams: Promise<{ vis?: string; side?: string }>;
}) {
  const { admin } = await kraevSideRolle("medarbejder");
  const { vis, side: sideParam } = await searchParams;
  const filter: Filter = FILTRE.some((f) => f.id === vis) ? (vis as Filter) : "aabne";
  const side = laesSide(sideParam);
  const nu = new Date().toISOString();

  let q = admin
    .from("ekstra_fragt_regninger")
    .select(
      "id, trade_id, saelger_id, transportoer, valgt_stoerrelse, maalt_stoerrelse, maalt_vaegt_gram, maalt_maal, beloeb_oere, status, frist, oprettet_kl, indsigelse_kl, kraever_opmaerksomhed, bankindsigelse_tabt_kl",
    );
  if (filter === "aabne") q = q.in("status", ["afventer_betaling", "behandles", "indsigelse"]);
  else if (filter === "indsigelse") q = q.eq("status", "indsigelse");
  else if (filter === "tabt") q = q.eq("status", "betalt").not("bankindsigelse_tabt_kl", "is", null);
  else if (filter === "spaerret") q = q.eq("status", "afventer_betaling").lte("frist", nu);
  else if (filter === "afventer") q = q.eq("status", "afventer_betaling");
  else if (filter === "betalt") q = q.eq("status", "betalt");
  else if (filter === "frafaldet") q = q.eq("status", "frafaldet");
  // Åbne: den med den tidligste frist (eller ældste indsigelse) først. Ellers nyeste først.
  q =
    filter === "indsigelse"
      ? q.order("indsigelse_kl", { ascending: true })
      : filter === "tabt"
        ? q.order("bankindsigelse_tabt_kl", { ascending: true })
        : filter === "aabne" || filter === "spaerret" || filter === "afventer"
        ? q.order("frist", { ascending: true })
        : q.order("oprettet_kl", { ascending: false });
  const fra = (side - 1) * PR_SIDE;

  const [svar, tal] = await Promise.all([
    q.order("id", { ascending: true }).range(fra, fra + PR_SIDE).overrideTypes<Raekke[], { merge: false }>(),
    hentStaffTal(),
  ]);
  const migrationMangler = svar.error?.code === "42P01" || svar.error?.code === "PGRST205";
  const raekker = (svar.data ?? []).slice(0, PR_SIDE);
  const harNaeste = (svar.data ?? []).length > PR_SIDE;

  // Titler og sælgernavne (små opslag i stedet for indlejrede joins).
  const tradeIds = [...new Set(raekker.map((r) => r.trade_id))];
  const saelgerIds = [...new Set(raekker.map((r) => r.saelger_id))];
  const [tradesR, saelgereR] = await Promise.all([
    tradeIds.length
      ? admin.from("trades").select("id, auction_id").in("id", tradeIds)
      : Promise.resolve({ data: [] as { id: string; auction_id: string | null }[] }),
    saelgerIds.length
      ? admin.from("users").select("id, navn").in("id", saelgerIds)
      : Promise.resolve({ data: [] as { id: string; navn: string | null }[] }),
  ]);
  const auktionIds = [...new Set((tradesR.data ?? []).map((t) => t.auction_id).filter((x): x is string => !!x))];
  const { data: auktioner } = auktionIds.length
    ? await admin.from("auctions").select("id, titel").in("id", auktionIds)
    : { data: [] as { id: string; titel: string | null }[] };
  const titelPrAuktion = new Map((auktioner ?? []).map((a) => [a.id, a.titel]));
  const titel = new Map((tradesR.data ?? []).map((t) => [t.id, t.auction_id ? (titelPrAuktion.get(t.auction_id) ?? null) : null]));
  const saelgerNavn = new Map((saelgereR.data ?? []).map((u) => [u.id, u.navn]));

  const href = (f: Filter, s = 1) => adminHref("/admin/ekstra-fragt", { vis: f === "aabne" ? null : f, side: s });
  const nuMs = Date.parse(nu);

  return (
    <AdminSide>
      <AdminSideHoved
        titel="Ekstra fragt"
        forklaring="Fragtfirmaet har opkrævet ekstra, fordi pakken var større eller tungere end den valgte størrelse. Sælgeren betaler selv forskellen – der trækkes aldrig automatisk i sælgerens penge."
        hjaelp={
          <>
            <p>
              Registrér en regning på handlens side (Handler → handlen → Ekstra fragt). Sælgeren får besked og har 14
              dage til at betale. Betales den ikke, kan sælgeren ikke oprette nye auktioner, før den er betalt.
            </p>
            <p>
              Rød betyder, at sælgeren har gjort indsigelse mod målingen. Afgør den: frafald eller fasthold. Fastholdes
              den, har sælgeren mindst 7 dage til at betale.
            </p>
            <p>
              Tabt bankindsigelse betyder, at sælgerens bank har tilbageført en betalt regning. Åbn den, og tryk
              Genåbn regning – sælgeren får 14 dage til at betale igen.
            </p>
          </>
        }
      />

      <AdminFilterChips
        label="Filtrér regninger"
        aktiv={filter}
        chips={FILTRE.map((f) => ({
          id: f.id,
          label: f.label,
          href: href(f.id),
          antal:
            f.id === "indsigelse"
              ? tal.ekstraFragtIndsigelser
              : f.id === "tabt"
                ? tal.ekstraFragtTabteBankindsigelser
                : f.id === "spaerret"
                ? tal.ekstraFragtForfaldne
                : f.id === "afventer"
                  ? tal.ekstraFragtAfventer
                  : undefined,
          tone: f.id === "indsigelse" || f.id === "tabt" ? ("roed" as const) : ("graa" as const),
        }))}
      />

      {svar.error ? (
        <AdminFejl
          hvad="Regningerne for ekstra fragt"
          detalje={migrationMangler ? "Kræver migrationen 20261029020000_ekstra_fragt.sql." : svar.error.message}
        />
      ) : raekker.length === 0 ? (
        <AdminTom
          tekst={side > 1 ? "Der er ikke flere regninger." : (TOMT[filter] ?? "Ingen regninger med denne status.")}
          link={filter !== "alle" ? { href: href("alle"), label: "Se alle regninger" } : undefined}
        />
      ) : (
        <ul className="overflow-hidden rounded-[14px] border border-admin-kant bg-white">
          {raekker.map((r) => {
            const spaerrer = r.status === "afventer_betaling" && Date.parse(r.frist) <= nuMs;
            const tabt = r.status === "betalt" && !!r.bankindsigelse_tabt_kl;
            const roed = r.status === "indsigelse" || r.kraever_opmaerksomhed || tabt;
            return (
              <li key={r.id} className="border-t border-admin-kant first:border-t-0">
                <Link
                  href={`/admin/ekstra-fragt/${r.id}`}
                  className={`flex flex-col gap-1 px-4 py-4 transition-colors hover:bg-admin-bg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-groen sm:flex-row sm:items-center sm:gap-4 sm:px-5 ${
                    roed ? "bg-fejl-bg/40" : ""
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <EkstraFragtStatusBadge status={r.status} spaerrer={spaerrer} />
                      {tabt && <AdminBadge tone="roed">Tabt bankindsigelse</AdminBadge>}
                      <span className="text-sm font-bold text-tekst tabular-nums">{oereKr(r.beloeb_oere)}</span>
                    </div>
                    <p className="mt-1.5 min-w-0 break-words font-semibold text-tekst">
                      {titel.get(r.trade_id) ?? "(slettet auktion)"}
                    </p>
                    <p className="text-sm text-tekst-daempet">
                      Sælger: {saelgerNavn.get(r.saelger_id) ?? "Uden navn"}
                      {transportoerNavn(r.transportoer) && <> · {transportoerNavn(r.transportoer)}</>} · Valgt{" "}
                      {valgtStoerrelseNavn(r.valgt_stoerrelse)}, målt {maalingTekst(r)}
                    </p>
                  </div>
                  <p className="shrink-0 text-xs text-tekst-svag sm:text-right">
                    Oprettet {ekstraFragtTid(r.oprettet_kl)}
                    {r.status === "afventer_betaling" && <span className="block">Frist {ekstraFragtTid(r.frist)}</span>}
                    {tabt && r.bankindsigelse_tabt_kl && (
                      <span className="block">Tilbageført {ekstraFragtTid(r.bankindsigelse_tabt_kl)}</span>
                    )}
                    {r.status === "indsigelse" && r.indsigelse_kl && (
                      <span className="block">Indsigelse {ekstraFragtTid(r.indsigelse_kl)}</span>
                    )}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <AdminSideskift side={side} harNaeste={harNaeste} lavHref={(s) => href(filter, s)} />
    </AdminSide>
  );
}
