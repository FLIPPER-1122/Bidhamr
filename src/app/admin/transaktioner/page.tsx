import { createClient } from "@/lib/supabase/server";
import { anonymUsername } from "@/lib/anonymUsername";

export default async function AdminTransaktioner() {
  const supabase = await createClient();

  const { data: transactions } = await supabase
    .from("transactions")
    .select("id, auktion_id, køber_id, sælger_id, beløb, gebyr, status, oprettet")
    .order("oprettet", { ascending: false });

  // Fetch auction titles
  const auktionIds = [...new Set((transactions ?? []).map((t) => t.auktion_id))];
  const { data: auctions } = auktionIds.length
    ? await supabase.from("auctions").select("id, titel").in("id", auktionIds)
    : { data: [] };

  const auktionMap: Record<string, string> = {};
  (auctions ?? []).forEach((a) => {
    auktionMap[a.id] = a.titel;
  });

  const totalRevenue = (transactions ?? [])
    .filter((t) => t.status === "frigivet")
    .reduce((sum, t) => sum + (t.beløb ?? 0), 0);

  const statusBadge = (s: string) => {
    if (s === "frigivet") return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">Frigivet</span>;
    if (s === "refunderet") return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">Refunderet</span>;
    return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">Afventer</span>;
  };

  return (
    <div className="p-6 space-y-5">
      <h1 className="text-2xl font-bold text-neutral-900">Transaktioner</h1>

      {/* Revenue card */}
      <div className="bg-white rounded-xl border border-neutral-200 p-5 inline-flex items-center gap-4">
        <div className="w-12 h-12 rounded-xl bg-[#E6394618] flex items-center justify-center">
          <svg className="w-6 h-6" fill="none" stroke="#E63946" strokeWidth={1.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z" />
          </svg>
        </div>
        <div>
          <p className="text-xs text-neutral-500 uppercase font-medium">Total omsætning (frigivet)</p>
          <p className="text-2xl font-bold text-neutral-900">
            {totalRevenue.toLocaleString("da-DK")} kr
          </p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-neutral-50 text-xs text-neutral-500 uppercase">
                <th className="px-5 py-3 text-left font-medium">Auktion</th>
                <th className="px-5 py-3 text-left font-medium">Køber</th>
                <th className="px-5 py-3 text-left font-medium">Sælger</th>
                <th className="px-5 py-3 text-left font-medium">Beløb</th>
                <th className="px-5 py-3 text-left font-medium">Gebyr</th>
                <th className="px-5 py-3 text-left font-medium">Status</th>
                <th className="px-5 py-3 text-left font-medium">Dato</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {(transactions ?? []).map((t) => (
                <tr key={t.id} className="hover:bg-neutral-50">
                  <td className="px-5 py-3 text-neutral-700 max-w-[180px] truncate">
                    {auktionMap[t.auktion_id] ?? t.auktion_id}
                  </td>
                  <td className="px-5 py-3 text-neutral-600 font-mono text-xs">
                    {anonymUsername(t["køber_id"])}
                  </td>
                  <td className="px-5 py-3 text-neutral-600 font-mono text-xs">
                    {anonymUsername(t["sælger_id"])}
                  </td>
                  <td className="px-5 py-3 text-neutral-800 font-medium">
                    {t["beløb"]?.toLocaleString("da-DK")} kr
                  </td>
                  <td className="px-5 py-3 text-neutral-600">
                    {t.gebyr?.toLocaleString("da-DK")} kr
                  </td>
                  <td className="px-5 py-3">{statusBadge(t.status)}</td>
                  <td className="px-5 py-3 text-neutral-500">
                    {new Date(t.oprettet).toLocaleDateString("da-DK")}
                  </td>
                </tr>
              ))}
              {(transactions ?? []).length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-neutral-400">
                    Ingen transaktioner endnu
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
