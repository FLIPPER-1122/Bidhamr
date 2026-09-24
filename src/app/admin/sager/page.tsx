import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getStaffRole, harMindstRolle } from "@/lib/adminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import AdminSearchInput from "@/components/admin/AdminSearchInput";
import ConfirmDialog from "@/components/admin/ConfirmDialog";
import HandelStatusBadge from "@/components/HandelStatusBadge";
import {
  sagAabn,
  sagLuk,
  handelFrigiv,
  handelRefunder,
} from "@/app/actions/adminActions";

// Sager er bevidst adskilt fra rapporter: en rapport handler om et opslag,
// en sag handler om en handel mellem to brugere efter auktionen er slut.

type HandelRow = {
  id: string;
  auction_id: string;
  seller_id: string;
  buyer_id: string;
  amount: number | string;
  status: string;
  tracking_number: string | null;
  created_at: string;
  received_at: string | null;
  sag_aaben: boolean;
  sag_note: string | null;
  sag_aabnet_at: string | null;
};

const AKTIVE = ["betaling_modtaget", "pakke_sendt", "modtaget"];

// En handel "hænger", hvis den har stået i samme trin for længe.
const FRIST_DAGE: Record<string, number> = {
  betaling_modtaget: 5, // sælger har ikke sendt
  pakke_sendt: 10, // køber har ikke kvitteret
  modtaget: 5, // køber har ikke godkendt
};

const FANER = [
  { key: "sager", label: "Åbne sager" },
  { key: "haenger", label: "Hænger" },
  { key: "aktive", label: "Aktive handler" },
  { key: "alle", label: "Alle" },
] as const;

function dageSiden(iso: string) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

function haenger(h: HandelRow) {
  const frist = FRIST_DAGE[h.status];
  if (!frist) return false;
  const fra = h.status === "modtaget" && h.received_at ? h.received_at : h.created_at;
  return dageSiden(fra) >= frist;
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

  const { q, vis } = await searchParams;
  const fane = FANER.some((f) => f.key === vis) ? vis! : "sager";
  const søgetekst = q?.trim() ?? "";
  const supabase = createAdminClient();

  const { data: handler } = await supabase
    .from("trades")
    .select(
      "id, auction_id, seller_id, buyer_id, amount, status, tracking_number, created_at, received_at, sag_aaben, sag_note, sag_aabnet_at",
    )
    .order("created_at", { ascending: false })
    .limit(500);

  const alle = (handler ?? []) as HandelRow[];

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
    haenger: alle.filter((h) => AKTIVE.includes(h.status) && haenger(h)).length,
    aktive: alle.filter((h) => AKTIVE.includes(h.status)).length,
    alle: alle.length,
  };

  let rows = alle.filter((h) => {
    if (fane === "sager") return h.sag_aaben;
    if (fane === "haenger") return AKTIVE.includes(h.status) && haenger(h);
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
        h.tracking_number, h.sag_note, h.id,
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
        <h1 className="text-2xl font-bold text-neutral-900">Sager</h1>
        <span className="text-sm text-neutral-500">
          {rows.length} {rows.length === 1 ? "handel" : "handler"}
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        {FANER.map((f) => {
          const aktiv = f.key === fane;
          const params = new URLSearchParams();
          params.set("vis", f.key);
          if (søgetekst) params.set("q", søgetekst);
          return (
            <Link
              key={f.key}
              href={`/admin/sager?${params}`}
              className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                aktiv
                  ? "bg-brand text-white"
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
                <th className="px-5 py-3 text-left font-medium">Sag</th>
                <th className="px-5 py-3 text-left font-medium">Handlinger</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {rows.map((h) => {
                const aktiv = AKTIVE.includes(h.status);
                const forsinket = aktiv && haenger(h);
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
                        {dageSiden(h.created_at)} d
                      </span>
                      {forsinket && <span className="block text-xs text-red-600">Hænger</span>}
                    </td>
                    <td className="px-5 py-3">
                      {h.sag_aaben ? (
                        <span className="block max-w-[220px] text-neutral-700">
                          <span className="mb-1 inline-block rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                            Åben sag
                          </span>
                          <span className="block text-xs">{h.sag_note}</span>
                        </span>
                      ) : (
                        <span className="text-neutral-400">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      {!aktiv ? (
                        <span className="text-xs text-neutral-400">Afsluttet</span>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {h.sag_aaben ? (
                            <ConfirmDialog
                              triggerLabel="Luk sag"
                              triggerClassName="whitespace-nowrap rounded-md bg-neutral-100 px-2 py-1 text-xs text-neutral-700 transition-colors hover:bg-neutral-200"
                              title="Luk sagen?"
                              description="Handlen fortsætter normalt. Ingen penge flyttes."
                              confirmLabel="Ja, luk sagen"
                              action={sagLuk}
                              hiddenFields={{ tradeId: h.id }}
                              aarsagField={{ label: "Afsluttende note", placeholder: "Hvad blev udfaldet?", required: true }}
                            />
                          ) : (
                            <ConfirmDialog
                              triggerLabel="Åbn sag"
                              triggerClassName="whitespace-nowrap rounded-md bg-amber-100 px-2 py-1 text-xs text-amber-800 transition-colors hover:bg-amber-200"
                              title="Åbn en sag på handlen?"
                              description="Handlen markeres til opfølgning. Parterne kan stadig bruge den normalt."
                              confirmLabel="Ja, åbn sag"
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
                                description="Køberen får købsbeløb + købergebyr tilbage i sin wallet. Sælgeren får intet. Kan ikke fortrydes."
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
                        ? "Ingen åbne sager"
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
