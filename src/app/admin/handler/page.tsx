import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getStaffRole, harMindstRolle } from "@/lib/adminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import AdminSearchInput from "@/components/admin/AdminSearchInput";
import ConfirmDialog from "@/components/admin/ConfirmDialog";
import HandelStatusBadge from "@/components/HandelStatusBadge";
import FaellesbeskedKnap from "@/components/admin/staffchat/FaellesbeskedKnap";
import { UUID_RE, handelChatSti } from "@/lib/moderationLog";
import { HAENGER_TEKST, erHaengerGrund, type HaengerGrund } from "@/lib/adminGraenser";
import {
  sagAabn,
  sagLuk,
  handelFrigiv,
  handelRefunder,
} from "@/app/actions/adminActions";

// Overblik over handler (flyttet fra /admin/sager, da sager fra køberen nu
// har deres egen side). Her kan staff markere en handel til opfølgning
// (trades.sag_aaben - fryser pengene), se handler der hænger, sende en
// fællesbesked og frigive/refundere manuelt. Sager fra køberen behandles
// under /admin/sager.

type HandelRow = {
  id: string;
  auction_id: string;
  seller_id: string;
  buyer_id: string;
  amount: number | string;
  status: string;
  tracking_number: string | null;
  created_at: string;
  sag_aaben: boolean;
  sag_note: string | null;
  sag_aabnet_at: string | null;
};

const AKTIVE = ["betaling_modtaget", "pakke_sendt", "modtaget"];

// Hvilke handler der "hænger", afgøres af SQL-funktionen
// admin_haengende_handler() – den samme, som tæller kortene på admin-forsiden
// (grænserne står i src/lib/adminGraenser.ts).
type Haenger = { grund: HaengerGrund; siden: string };

const FANER = [
  { key: "sager", label: "Markerede" },
  { key: "haenger", label: "Hænger" },
  { key: "aktive", label: "Aktive handler" },
  { key: "alle", label: "Alle" },
] as const;

function dageSiden(iso: string) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

const kr = (v: number | string) =>
  Number(v).toLocaleString("da-DK", { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + " kr";

export default async function AdminSager({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; vis?: string }>;
}) {
  const rolle = await getStaffRole();
  if (!rolle) redirect("/");
  const kanFlyttePenge = harMindstRolle(rolle, "admin");
  // Fællesbesked til køber og sælger: kun admin og chef.
  const kanSkriveFaelles = harMindstRolle(rolle, "admin");

  const { q, vis } = await searchParams;
  const fane = FANER.some((f) => f.key === vis) ? vis! : "haenger";
  const søgetekst = q?.trim() ?? "";
  const supabase = createAdminClient();

  const KOLONNER =
    "id, auction_id, seller_id, buyer_id, amount, status, tracking_number, created_at, sag_aaben, sag_note, sag_aabnet_at";

  const [{ data: handler }, { data: haengende, error: haengerFejl }] = await Promise.all([
    supabase.from("trades").select(KOLONNER).order("created_at", { ascending: false }).limit(500),
    supabase.rpc("admin_haengende_handler"),
  ]);
  if (haengerFejl) console.error("admin_haengende_handler fejlede:", haengerFejl.message);

  const haengerMap = new Map<string, Haenger>();
  for (const r of (haengende ?? []) as { trade_id: string; grund: unknown; siden: string }[]) {
    if (erHaengerGrund(r.grund)) haengerMap.set(r.trade_id, { grund: r.grund, siden: r.siden });
  }

  // Kun de 500 nyeste hentes. Ældre handler hentes med, når de hænger, eller
  // når der søges på et id (handel, auktion, køber eller sælger) – fx fra et
  // link i medarbejder-loggen.
  const nyeste = (handler ?? []) as HandelRow[];
  const kendte = new Set(nyeste.map((h) => h.id));
  const mangler = [...haengerMap.keys()].filter((id) => !kendte.has(id)).slice(0, 500);
  const søgUuid = UUID_RE.test(søgetekst) ? søgetekst.toLowerCase() : null;
  const [{ data: ekstra }, { data: idTraef }] = await Promise.all([
    mangler.length
      ? supabase.from("trades").select(KOLONNER).in("id", mangler)
      : Promise.resolve({ data: [] as HandelRow[] }),
    søgUuid
      ? supabase
          .from("trades")
          .select(KOLONNER)
          .or(`id.eq.${søgUuid},auction_id.eq.${søgUuid},buyer_id.eq.${søgUuid},seller_id.eq.${søgUuid}`)
          .order("created_at", { ascending: false })
          .limit(200)
      : Promise.resolve({ data: [] as HandelRow[] }),
  ]);
  const alle = [...nyeste];
  for (const h of [...((ekstra ?? []) as HandelRow[]), ...((idTraef ?? []) as HandelRow[])]) {
    if (!kendte.has(h.id)) {
      kendte.add(h.id);
      alle.push(h);
    }
  }
  alle.sort((x, y) => y.created_at.localeCompare(x.created_at));
  const haenger = (h: HandelRow) => haengerMap.has(h.id);

  const auktionIds = [...new Set(alle.map((h) => h.auction_id))];
  const brugerIds = [...new Set(alle.flatMap((h) => [h.buyer_id, h.seller_id]))];

  const [{ data: auktioner }, { data: brugere }] = await Promise.all([
    auktionIds.length
      ? supabase.from("auctions").select("id, titel").in("id", auktionIds)
      : Promise.resolve({ data: [] as { id: string; titel: string }[] }),
    brugerIds.length
      ? supabase.from("users").select("id, navn, email").in("id", brugerIds)
      : Promise.resolve({ data: [] as { id: string; navn: string | null; email: string }[] }),
  ]);

  const titelMap = new Map((auktioner ?? []).map((a) => [a.id, a.titel as string]));
  const brugerMap = new Map(
    (brugere ?? []).map((u) => [u.id, { navn: u.navn as string | null, email: u.email as string }]),
  );

  const antal = {
    sager: alle.filter((h) => h.sag_aaben).length,
    haenger: alle.filter(haenger).length,
    aktive: alle.filter((h) => AKTIVE.includes(h.status)).length,
    alle: alle.length,
  };

  let rows = alle.filter((h) => {
    if (fane === "sager") return h.sag_aaben;
    if (fane === "haenger") return haenger(h);
    if (fane === "aktive") return AKTIVE.includes(h.status);
    return true;
  });

  if (søgetekst) {
    const nål = søgetekst.toLowerCase();
    rows = rows.filter((h) => {
      const k = brugerMap.get(h.buyer_id);
      const s = brugerMap.get(h.seller_id);
      return [
        titelMap.get(h.auction_id),
        k?.navn, k?.email, s?.navn, s?.email,
        h.tracking_number, h.sag_note, h.id, h.auction_id, h.buyer_id, h.seller_id,
      ].some((v) => (v ?? "").toLowerCase().includes(nål));
    });
  }

  function Person({ id }: { id: string }) {
    const p = brugerMap.get(id);
    if (!p) return <span className="text-neutral-400">—</span>;
    return (
      <Link href={`/admin/brugere/${id}`} className="block max-w-[150px] hover:underline">
        <span className="block truncate text-neutral-800">{p.navn ?? "Uden navn"}</span>
        <span className="block truncate text-xs text-neutral-500">{p.email}</span>
      </Link>
    );
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-neutral-900">Handler</h1>
        <span className="text-sm text-neutral-500">
          {rows.length} {rows.length === 1 ? "handel" : "handler"}
        </span>
      </div>

      <p className="text-sm text-neutral-500">
        Sager oprettet af køberen behandles under{" "}
        <Link href="/admin/sager" className="font-medium text-groen hover:underline">
          Sager
        </Link>
        . En markering her fryser pengene, indtil den fjernes.
      </p>

      {haengerFejl && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          Handler, der hænger, kunne ikke hentes lige nu. Prøv at genindlæse siden.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {FANER.map((f) => {
          const aktiv = f.key === fane;
          const params = new URLSearchParams();
          params.set("vis", f.key);
          if (søgetekst) params.set("q", søgetekst);
          return (
            <Link
              key={f.key}
              href={`/admin/handler?${params}`}
              className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                aktiv
                  ? "bg-orange-knap text-white"
                  : "bg-white border border-neutral-200 text-neutral-700 hover:bg-neutral-100"
              }`}
            >
              {f.label}
              <span className={`ml-1.5 text-xs ${aktiv ? "text-white/80" : "text-neutral-400"}`}>
                {antal[f.key]}
              </span>
            </Link>
          );
        })}
      </div>

      <Suspense>
        <AdminSearchInput placeholder="Søg på auktion, køber, sælger, tracking eller note..." />
      </Suspense>

      <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-neutral-50 text-xs text-neutral-500 uppercase">
                <th className="px-5 py-3 text-left font-medium">Auktion</th>
                <th className="px-5 py-3 text-left font-medium">Køber</th>
                <th className="px-5 py-3 text-left font-medium">Sælger</th>
                <th className="px-5 py-3 text-right font-medium">Beløb</th>
                <th className="px-5 py-3 text-left font-medium">Status</th>
                <th className="px-5 py-3 text-left font-medium">Alder</th>
                <th className="px-5 py-3 text-left font-medium">Markering</th>
                <th className="px-5 py-3 text-left font-medium">Handlinger</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {rows.map((h) => {
                const aktiv = AKTIVE.includes(h.status);
                const forsinket = haengerMap.get(h.id);
                return (
                  <tr key={h.id} className={`align-top ${h.sag_aaben ? "bg-red-50/40" : "hover:bg-neutral-50"}`}>
                    <td className="px-5 py-3">
                      <Link
                        href={`/auktion/${h.auction_id}`}
                        className="font-medium text-neutral-800 hover:text-brand hover:underline"
                      >
                        {titelMap.get(h.auction_id) ?? "(slettet auktion)"}
                      </Link>
                      {h.tracking_number && (
                        <span className="mt-0.5 block text-xs text-neutral-500">
                          Tracking: {h.tracking_number}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3"><Person id={h.buyer_id} /></td>
                    <td className="px-5 py-3"><Person id={h.seller_id} /></td>
                    <td className="px-5 py-3 text-right whitespace-nowrap font-medium text-neutral-800">
                      {kr(h.amount)}
                    </td>
                    <td className="px-5 py-3"><HandelStatusBadge status={h.status} /></td>
                    <td className="px-5 py-3 whitespace-nowrap">
                      <span className={forsinket ? "font-semibold text-red-600" : "text-neutral-500"}>
                        {dageSiden(forsinket ? forsinket.siden : h.created_at)} d
                      </span>
                      {forsinket && (
                        <span className="block text-xs text-red-600">{HAENGER_TEKST[forsinket.grund]}</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      {h.sag_aaben ? (
                        <span className="block max-w-[220px] text-neutral-700">
                          <span className="mb-1 inline-block rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                            Markeret
                          </span>
                          <span className="block text-xs">{h.sag_note}</span>
                        </span>
                      ) : (
                        <span className="text-neutral-400">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <div className="mb-2">
                        {/* prefetch slået fra: chatsiden logger læsningen. */}
                        <Link
                          href={handelChatSti(h.id)}
                          prefetch={false}
                          className="inline-flex whitespace-nowrap rounded-md bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-200"
                        >
                          Se chat
                        </Link>
                      </div>
                      {kanSkriveFaelles && (
                        <div className="mb-2">
                          <FaellesbeskedKnap tradeId={h.id} />
                        </div>
                      )}
                      {!aktiv ? (
                        <span className="text-xs text-neutral-400">Afsluttet</span>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {h.sag_aaben ? (
                            <ConfirmDialog
                              triggerLabel="Fjern markering"
                              triggerClassName="whitespace-nowrap rounded-md bg-neutral-100 px-2 py-1 text-xs text-neutral-700 transition-colors hover:bg-neutral-200"
                              title="Fjern markeringen?"
                              description="Handlen fortsætter normalt. Ingen penge flyttes."
                              confirmLabel="Ja, fjern markeringen"
                              action={sagLuk}
                              hiddenFields={{ tradeId: h.id }}
                              aarsagField={{ label: "Afsluttende note", placeholder: "Hvad blev udfaldet?", required: true }}
                            />
                          ) : (
                            <ConfirmDialog
                              triggerLabel="Markér handel"
                              triggerClassName="whitespace-nowrap rounded-md bg-amber-100 px-2 py-1 text-xs text-amber-800 transition-colors hover:bg-amber-200"
                              title="Markér handlen til opfølgning?"
                              description="Handlen markeres til opfølgning, og pengene fryses, indtil markeringen fjernes. Parterne kan stadig bruge handlen normalt."
                              confirmLabel="Ja, markér handlen"
                              action={sagAabn}
                              hiddenFields={{ tradeId: h.id }}
                              aarsagField={{ label: "Hvad drejer sagen sig om?", placeholder: "Fx: køber melder varen defekt, sælger svarer ikke...", required: true }}
                            />
                          )}
                          {kanFlyttePenge && (
                            <>
                              <ConfirmDialog
                                triggerLabel="Frigiv til sælger"
                                triggerClassName="whitespace-nowrap rounded-md bg-green-100 px-2 py-1 text-xs text-green-800 transition-colors hover:bg-green-200"
                                title={`Frigiv ${kr(h.amount)} til sælgeren?`}
                                description="Sælgeren afregnes (minus 5% gebyr), som om køberen havde godkendt varen. Kan ikke fortrydes."
                                confirmLabel="Ja, frigiv pengene"
                                action={handelFrigiv}
                                hiddenFields={{ tradeId: h.id }}
                                aarsagField={{ label: "Begrundelse", placeholder: "Hvorfor frigives beløbet uden køberens godkendelse?", required: true }}
                              />
                              <ConfirmDialog
                                triggerLabel="Refundér køber"
                                triggerClassName="whitespace-nowrap rounded-md bg-red-100 px-2 py-1 text-xs text-red-700 transition-colors hover:bg-red-200"
                                title="Refundér køberen og annullér handlen?"
                                description="Køberen får hele det betalte beløb (bud, købergebyr, fragt og evt. BidHamr Beskyttelse) tilbage via Stripe. Er handlen ikke betalt endnu, annulleres betalingen. Sælgeren får intet. Kan ikke fortrydes."
                                confirmLabel="Ja, refundér"
                                action={handelRefunder}
                                hiddenFields={{ tradeId: h.id }}
                                aarsagField={{ label: "Begrundelse", placeholder: "Hvorfor refunderes køberen?", required: true }}
                              />
                            </>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-10 text-center text-neutral-400">
                    {søgetekst
                      ? `Ingen handler matcher "${søgetekst}"`
                      : fane === "sager"
                        ? "Ingen markerede handler"
                        : fane === "haenger"
                          ? "Ingen handler hænger lige nu"
                          : "Ingen handler endnu"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
