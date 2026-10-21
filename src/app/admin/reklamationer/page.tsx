import Link from "next/link";
import AdminSide from "@/components/admin/AdminSide";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import AdminFilterChips from "@/components/admin/AdminFilterChips";
import AdminFejl from "@/components/admin/AdminFejl";
import AdminTom from "@/components/admin/AdminTom";
import AdminBadge from "@/components/admin/AdminBadge";
import AdminSideskift, { adminHref, laesSide } from "@/components/admin/AdminSideskift";
import {
  ReklamationStatusBadge,
  dageSiden,
  erSagAendret,
  erStille,
  reklamationTid,
} from "@/components/admin/reklamation/visning";
import { hentStaffTal } from "@/lib/admin/taellere";
import { kraevSideRolle } from "@/lib/adminAuth";
import {
  REKLAMATION_STILLE_DAGE,
  kroner,
  transportoerNavn,
  type ReklamationStatus,
  type ReklamationTransportoer,
} from "@/lib/reklamation/typer";

// Reklamationer hos fragtfirmaet (ROADMAP-BESLUTNINGER afsnit 4, Filip 21.
// okt. 2026). Sælgeren anmelder selv skaden; staff følger med, sender
// oplysningerne igen og retter status. Det, der kræver staff (stået stille i
// 14 dage, sagen ændret efter anmeldelsen), står som røde filtre øverst.

export const metadata = { title: "Reklamationer" };

const PR_SIDE = 20;

const FILTRE = [
  { id: "aabne", label: "Åbne" },
  { id: "stille", label: `Stille i ${REKLAMATION_STILLE_DAGE} dage` },
  { id: "sag_aendret", label: "Sag ændret" },
  { id: "afventer_saelger", label: "Venter på sælger" },
  { id: "anmeldt", label: "Anmeldt" },
  { id: "godkendt", label: "Godkendt" },
  { id: "afvist", label: "Afvist" },
  { id: "fravalgt", label: "Fravalgt" },
  { id: "annulleret", label: "Annulleret" },
  { id: "alle", label: "Alle" },
] as const;
type Filter = (typeof FILTRE)[number]["id"];

const TOMT: Partial<Record<Filter, string>> = {
  aabne: "Ingen åbne reklamationer lige nu.",
  stille: "Ingen reklamationer har stået stille.",
  sag_aendret: "Ingen sager er ændret efter en anmeldelse.",
};

type Raekke = {
  id: string;
  sag_id: string;
  trade_id: string;
  saelger_id: string;
  transportoer: ReklamationTransportoer;
  status: ReklamationStatus;
  kravbeloeb_oere: number;
  godkendt_beloeb_oere: number | null;
  oprettet_kl: string;
  fremdrift_kl: string;
  sag_aendret_kl: string | null;
  sag_aendret_kvitteret_kl: string | null;
  gensendt_antal: number;
};

export default async function AdminReklamationer({
  searchParams,
}: {
  searchParams: Promise<{ vis?: string; side?: string }>;
}) {
  const { admin } = await kraevSideRolle("medarbejder");
  const { vis, side: sideParam } = await searchParams;
  const filter: Filter = FILTRE.some((f) => f.id === vis) ? (vis as Filter) : "aabne";
  const side = laesSide(sideParam);
  const nu = new Date().getTime();
  const graense = new Date(nu - REKLAMATION_STILLE_DAGE * 24 * 3600 * 1000).toISOString();

  let q = admin
    .from("fragt_reklamationer")
    .select(
      "id, sag_id, trade_id, saelger_id, transportoer, status, kravbeloeb_oere, godkendt_beloeb_oere, oprettet_kl, fremdrift_kl, sag_aendret_kl, sag_aendret_kvitteret_kl, gensendt_antal",
    );
  if (filter === "aabne") q = q.in("status", ["afventer_saelger", "anmeldt"]);
  else if (filter === "stille") q = q.in("status", ["afventer_saelger", "anmeldt"]).lt("fremdrift_kl", graense);
  else if (filter === "sag_aendret") q = q
      .in("status", ["anmeldt", "godkendt"])
      .not("sag_aendret_kl", "is", null)
      .is("sag_aendret_kvitteret_kl", null);
  else if (filter !== "alle") q = q.eq("status", filter);
  // Åbne: den, der har ventet længst, først. Ellers nyeste først.
  const aabenListe = filter === "aabne" || filter === "stille" || filter === "afventer_saelger" || filter === "anmeldt";
  q = aabenListe
    ? q.order("fremdrift_kl", { ascending: true })
    : q.order("opdateret_kl", { ascending: false });
  const fra = (side - 1) * PR_SIDE;

  const [svar, tal] = await Promise.all([
    q.order("id", { ascending: true }).range(fra, fra + PR_SIDE).overrideTypes<Raekke[], { merge: false }>(),
    hentStaffTal(),
  ]);
  const migrationMangler = svar.error?.code === "42P01" || svar.error?.code === "PGRST205";
  const raekker = (svar.data ?? []).slice(0, PR_SIDE);
  const harNaeste = (svar.data ?? []).length > PR_SIDE;

  // Titler og sælgernavne (to små opslag i stedet for indlejrede joins).
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

  const href = (f: Filter, s = 1) => adminHref("/admin/reklamationer", { vis: f === "aabne" ? null : f, side: s });

  return (
    <AdminSide>
      <AdminSideHoved
        titel="Reklamationer"
        forklaring="Varen blev skadet under fragten, og sælgeren pakkede ordentligt. Sælgeren anmelder selv skaden hos fragtfirmaet og får erstatningen direkte. Her følger du med og hjælper, hvis det går i stå."
        hjaelp={
          <>
            <p>
              En reklamation oprettes automatisk, når en sag om skade er afgjort til køberen, og indpakningen er
              vurderet som ordentlig på sagen. Sælgeren får besked med alle oplysninger og billeder.
            </p>
            <p>
              Rød betyder, at du skal se på den: intet er sket i {REKLAMATION_STILLE_DAGE} dage, eller sagen er
              ændret, efter sælgeren anmeldte skaden.
            </p>
          </>
        }
      />

      <AdminFilterChips
        label="Filtrér reklamationer"
        aktiv={filter}
        chips={FILTRE.map((f) => ({
          id: f.id,
          label: f.label,
          href: href(f.id),
          antal:
            f.id === "stille"
              ? tal.reklamationStille
              : f.id === "sag_aendret"
                ? tal.reklamationSagAendret
                : f.id === "afventer_saelger"
                  ? tal.reklamationAfventer
                  : undefined,
          tone: f.id === "stille" || f.id === "sag_aendret" ? ("roed" as const) : ("graa" as const),
        }))}
      />

      {svar.error ? (
        <AdminFejl
          hvad="Reklamationerne"
          detalje={migrationMangler ? "Kræver migrationen 20261029010000_reklamation_fragtfirma.sql." : svar.error.message}
        />
      ) : raekker.length === 0 ? (
        <AdminTom
          tekst={side > 1 ? "Der er ikke flere reklamationer." : (TOMT[filter] ?? "Ingen reklamationer med denne status.")}
          link={filter !== "alle" ? { href: href("alle"), label: "Se alle reklamationer" } : undefined}
        />
      ) : (
        <ul className="overflow-hidden rounded-[14px] border border-admin-kant bg-white">
          {raekker.map((r) => {
            const stille = erStille(r.status, r.fremdrift_kl, nu);
            const aendret = erSagAendret(r.status, r.sag_aendret_kl, r.sag_aendret_kvitteret_kl);
            const dage = dageSiden(r.fremdrift_kl, nu);
            return (
              <li key={r.id} className="border-t border-admin-kant first:border-t-0">
                <Link
                  href={`/admin/reklamationer/${r.id}`}
                  className={`flex flex-col gap-1 px-4 py-4 transition-colors hover:bg-admin-bg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-groen sm:flex-row sm:items-center sm:gap-4 sm:px-5 ${
                    stille || aendret ? "bg-fejl-bg/40" : ""
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <ReklamationStatusBadge status={r.status} />
                      {aendret && <AdminBadge tone="roed">Sagen er ændret</AdminBadge>}
                      {stille && <AdminBadge tone="roed">Stille i {dage} dage</AdminBadge>}
                      <AdminBadge tone="graa">{transportoerNavn(r.transportoer)}</AdminBadge>
                    </div>
                    <p className="mt-1.5 min-w-0 break-words font-semibold text-tekst">
                      {titel.get(r.trade_id) ?? "(slettet auktion)"}
                    </p>
                    <p className="text-sm text-tekst-daempet">
                      Sælger: {saelgerNavn.get(r.saelger_id) ?? "Uden navn"} · Krav {kroner(r.kravbeloeb_oere)}
                      {r.godkendt_beloeb_oere != null && <> · Godkendt {kroner(r.godkendt_beloeb_oere)}</>}
                    </p>
                  </div>
                  <p className="shrink-0 text-xs text-tekst-svag sm:text-right">
                    Oprettet {reklamationTid(r.oprettet_kl)}
                    <span className="block">Seneste fremdrift {reklamationTid(r.fremdrift_kl)}</span>
                    {r.gensendt_antal > 0 && (
                      <span className="block">
                        Sendt igen {r.gensendt_antal} {r.gensendt_antal === 1 ? "gang" : "gange"}
                      </span>
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
