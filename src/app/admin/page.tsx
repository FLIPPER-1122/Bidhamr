import { redirect } from "next/navigation";
import { getStaffRole } from "@/lib/adminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import StatCard from "@/components/admin/StatCard";
import BarChart from "@/components/admin/BarChart";
import type { TransaktionBeløbRow } from "@/lib/adminRowTypes";

function formatKr(value: number) {
  return value.toLocaleString("da-DK", { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + " kr";
}

function groupByDate(rows: { oprettet: string }[]) {
  // Nøgle: "YYYY-MM-DD", label: "d/M" (f.eks. "28/6")
  const counts: Record<string, { label: string; value: number }> = {};
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);

  for (let i = 0; i < 30; i++) {
    const d = new Date(thirtyDaysAgo);
    d.setDate(thirtyDaysAgo.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    const label = `${d.getDate()}/${d.getMonth() + 1}`;
    counts[key] = { label, value: 0 };
  }

  rows.forEach((row) => {
    const key = row.oprettet.slice(0, 10);
    if (key in counts) counts[key].value++;
  });

  return Object.values(counts);
}

export default async function AdminDashboard() {
  const rolle = await getStaffRole();
  if (rolle !== "chef") {
    redirect("/admin/brugere");
  }

  const supabase = createAdminClient();

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const thirtyDaysAgoISO = thirtyDaysAgo.toISOString();

  const [
    { count: totalUsers },
    { count: activeAuctions },
    { count: finishedAuctions },
    { data: transactions },
    { data: newUsersRaw },
    { data: newTransactionsRaw },
    { data: latestAuctions },
    { data: latestVenteliste },
  ] = await Promise.all([
    supabase.from("users").select("id", { count: "exact", head: true }),
    supabase.from("auctions").select("id", { count: "exact", head: true }).eq("status", "aktiv"),
    supabase.from("auctions").select("id", { count: "exact", head: true }).eq("status", "afsluttet"),
    supabase.from("transactions").select("beløb, gebyr").eq("status", "frigivet").overrideTypes<TransaktionBeløbRow[], { merge: false }>(),
    supabase.from("users").select("oprettet").gte("oprettet", thirtyDaysAgoISO),
    supabase.from("transactions").select("oprettet").gte("oprettet", thirtyDaysAgoISO).eq("status", "frigivet"),
    supabase.from("auctions").select("id, titel, bruger_id, status, oprettet").order("oprettet", { ascending: false }).limit(5),
    supabase.from("venteliste").select("email, oprettet").order("oprettet", { ascending: false }).limit(5),
  ]);

  const totalRevenue = (transactions ?? []).reduce((sum, t) => sum + (t.beløb ?? 0), 0);
  const totalFees = (transactions ?? []).reduce((sum, t) => sum + (t.gebyr ?? 0), 0);

  const userChartData = groupByDate((newUsersRaw ?? []) as { oprettet: string }[]);
  const txChartData = groupByDate((newTransactionsRaw ?? []) as { oprettet: string }[]);

  const statusBadge = (status: string) => {
    if (status === "aktiv") return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">Aktiv</span>;
    if (status === "afsluttet") return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-neutral-100 text-neutral-600">Afsluttet</span>;
    return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">Annulleret</span>;
  };

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold text-neutral-900">Dashboard</h1>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
        <StatCard
          title="Brugere i alt"
          value={totalUsers ?? 0}
          icon="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"
        />
        <StatCard
          title="Aktive auktioner"
          value={activeAuctions ?? 0}
          icon="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          color="#10b981"
        />
        <StatCard
          title="Afsluttede auktioner"
          value={finishedAuctions ?? 0}
          icon="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          color="#6366f1"
        />
        <StatCard
          title="Omsætning"
          value={formatKr(totalRevenue)}
          icon="M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z"
          color="#f59e0b"
        />
        <StatCard
          title="Gebyrindtægter"
          value={formatKr(totalFees)}
          icon="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z"
          color="#E63946"
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <BarChart data={userChartData} title="Nye brugere (30 dage)" />
        <BarChart data={txChartData} title="Gennemførte handler (30 dage)" />
      </div>

      {/* Latest tables */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Latest auctions */}
        <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
          <div className="px-5 py-4 border-b border-neutral-100">
            <h2 className="font-semibold text-neutral-800 text-sm">Seneste auktioner</h2>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-neutral-50 text-xs text-neutral-500 uppercase">
                <th className="px-5 py-3 text-left font-medium">Titel</th>
                <th className="px-5 py-3 text-left font-medium">Status</th>
                <th className="px-5 py-3 text-left font-medium">Oprettet</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {(latestAuctions ?? []).map((a) => (
                <tr key={a.id} className="hover:bg-neutral-50">
                  <td className="px-5 py-3 text-neutral-700 truncate max-w-[180px]">{a.titel}</td>
                  <td className="px-5 py-3">{statusBadge(a.status)}</td>
                  <td className="px-5 py-3 text-neutral-500">{new Date(a.oprettet).toLocaleDateString("da-DK")}</td>
                </tr>
              ))}
              {(latestAuctions ?? []).length === 0 && (
                <tr><td colSpan={3} className="px-5 py-6 text-center text-neutral-400">Ingen auktioner</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Latest waitlist */}
        <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
          <div className="px-5 py-4 border-b border-neutral-100">
            <h2 className="font-semibold text-neutral-800 text-sm">Seneste ventelisteindmeldinger</h2>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-neutral-50 text-xs text-neutral-500 uppercase">
                <th className="px-5 py-3 text-left font-medium">Email</th>
                <th className="px-5 py-3 text-left font-medium">Oprettet</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {(latestVenteliste ?? []).map((v, i) => (
                <tr key={i} className="hover:bg-neutral-50">
                  <td className="px-5 py-3 text-neutral-700">{v.email}</td>
                  <td className="px-5 py-3 text-neutral-500">{new Date(v.oprettet).toLocaleDateString("da-DK")}</td>
                </tr>
              ))}
              {(latestVenteliste ?? []).length === 0 && (
                <tr><td colSpan={2} className="px-5 py-6 text-center text-neutral-400">Ingen indmeldinger</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
