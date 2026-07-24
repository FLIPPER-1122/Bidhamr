import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { deleteAuction, cancelAuction } from "@/app/actions/adminActions";
import type { AdminAuktionRow } from "@/lib/adminRowTypes";

const statusOptions = ["alle", "aktiv", "afsluttet", "annulleret"] as const;

export default async function AdminAuktioner({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const supabase = await createClient();

  let query = supabase
    .from("auctions")
    .select("id, titel, billeder, startpris, nuværende_bud, status, slutter_kl, oprettet, bruger_id")
    .order("oprettet", { ascending: false });

  if (status && status !== "alle") {
    query = query.eq("status", status);
  }

  const { data: auctions } = await query.overrideTypes<AdminAuktionRow[], { merge: false }>();

  // Fetch user info for sælgere
  const brugerIds = [...new Set((auctions ?? []).map((a) => a.bruger_id))];
  const { data: sælgere } = brugerIds.length
    ? await supabase.from("users").select("id, navn, email").in("id", brugerIds)
    : { data: [] };

  const sælgerMap: Record<string, string> = {};
  (sælgere ?? []).forEach((u) => {
    sælgerMap[u.id] = u.navn ?? u.email ?? u.id;
  });

  const statusBadge = (s: string) => {
    if (s === "aktiv") return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">Aktiv</span>;
    if (s === "afsluttet") return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-neutral-100 text-neutral-600">Afsluttet</span>;
    return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">Annulleret</span>;
  };

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-neutral-900">Auktioner</h1>
        <span className="text-sm text-neutral-500">{auctions?.length ?? 0} resultater</span>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-2 flex-wrap">
        {statusOptions.map((s) => {
          const active = (status ?? "alle") === s;
          return (
            <Link
              key={s}
              href={`/admin/auktioner${s === "alle" ? "" : `?status=${s}`}`}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                active
                  ? "bg-[#E63946] text-white"
                  : "bg-white border border-neutral-200 text-neutral-600 hover:bg-neutral-50"
              }`}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </Link>
          );
        })}
      </div>

      <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-neutral-50 text-xs text-neutral-500 uppercase">
                <th className="px-5 py-3 text-left font-medium">Billede</th>
                <th className="px-5 py-3 text-left font-medium">Titel</th>
                <th className="px-5 py-3 text-left font-medium">Sælger</th>
                <th className="px-5 py-3 text-left font-medium">Startpris</th>
                <th className="px-5 py-3 text-left font-medium">Nuv. bud</th>
                <th className="px-5 py-3 text-left font-medium">Status</th>
                <th className="px-5 py-3 text-left font-medium">Slutter</th>
                <th className="px-5 py-3 text-left font-medium">Handlinger</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {(auctions ?? []).map((a) => {
                const img = Array.isArray(a.billeder) ? a.billeder[0] : null;
                return (
                  <tr key={a.id} className="hover:bg-neutral-50">
                    <td className="px-5 py-3">
                      {img ? (
                        <img src={img} alt={a.titel} className="w-10 h-10 rounded-lg object-cover" />
                      ) : (
                        <div className="w-10 h-10 rounded-lg bg-neutral-100 flex items-center justify-center">
                          <svg className="w-4 h-4 text-neutral-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
                          </svg>
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3 font-medium text-neutral-800 max-w-[160px] truncate">{a.titel}</td>
                    <td className="px-5 py-3 text-neutral-600">{sælgerMap[a.bruger_id] ?? "—"}</td>
                    <td className="px-5 py-3 text-neutral-600">{a.startpris?.toLocaleString("da-DK")} kr</td>
                    <td className="px-5 py-3 text-neutral-600">{a["nuværende_bud"] != null ? `${a["nuværende_bud"].toLocaleString("da-DK")} kr` : "—"}</td>
                    <td className="px-5 py-3">{statusBadge(a.status)}</td>
                    <td className="px-5 py-3 text-neutral-500">
                      {a["slutter_kl"] ? new Date(a["slutter_kl"]).toLocaleDateString("da-DK") : "—"}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex gap-2">
                        {a.status === "aktiv" && (
                          <form action={cancelAuction}>
                            <input type="hidden" name="auktionId" value={a.id} />
                            <button
                              type="submit"
                              className="px-2 py-1 text-xs bg-amber-100 text-amber-700 rounded-md hover:bg-amber-200 transition-colors"
                            >
                              Annullér
                            </button>
                          </form>
                        )}
                        <form action={deleteAuction}>
                          <input type="hidden" name="auktionId" value={a.id} />
                          <button
                            type="submit"
                            className="px-2 py-1 text-xs bg-red-100 text-red-700 rounded-md hover:bg-red-200 transition-colors"
                          >
                            Slet
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {(auctions ?? []).length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-10 text-center text-neutral-400">
                    Ingen auktioner fundet
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
