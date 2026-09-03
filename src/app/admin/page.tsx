import { redirect } from "next/navigation";
import { getStaffRole } from "@/lib/adminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import StatCard from "@/components/admin/StatCard";

function formatKr(value: number) {
  return value.toLocaleString("da-DK", { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + " kr";
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
  const nuISO = new Date().toISOString();

  const [
    { count: totalUsers },
    { count: activeAuctions },
    { count: finishedAuctions },
    { data: handler },
    { count: newUsers },
    { count: newTransactions },
  ] = await Promise.all([
    supabase.from("users").select("id", { count: "exact", head: true }),
    // Aktiv = status 'aktiv' OG slutdato i fremtiden. Uden tidsfilteret talte
    // udloebne auktioner med, fordi intet job saetter status til 'afsluttet'.
    supabase.from("auctions").select("id", { count: "exact", head: true }).eq("status", "aktiv").gt("slutter_kl", nuISO),
    // Afsluttet = eksplicit markeret afsluttet, eller udloebet uden at vaere annulleret.
    supabase.from("auctions").select("id", { count: "exact", head: true }).or(`status.eq.afsluttet,and(status.eq.aktiv,slutter_kl.lte."${nuISO}")`),
    // Omsaetning og gebyrer kommer nu fra e-money-afregningen. En handel
    // oprettes foerst naar pengene faktisk er flyttet mellem konti.
    supabase.from("trades").select("amount"),
    supabase.from("users").select("id", { count: "exact", head: true }).gte("oprettet", thirtyDaysAgoISO),
    supabase.from("trades").select("id", { count: "exact", head: true }).gte("created_at", thirtyDaysAgoISO),
  ]);

  // Omsaetning = summen af alle gennemfoerte handler. Gebyrindtaegten er de
  // to gebyrlinjer i hovedbogen (5% koeber + 10% saelger), som staar med
  // negativt fortegn hos brugeren og derfor vendes her.
  const totalRevenue = (handler ?? []).reduce(
    (sum, t) => sum + Number(t.amount ?? 0),
    0,
  );

  const { data: gebyrLinjer } = await supabase
    .from("wallet_entries")
    .select("amount")
    .in("kind", ["koebergebyr", "saelgergebyr"]);

  const totalFees = (gebyrLinjer ?? []).reduce(
    (sum, l) => sum + Math.abs(Number(l.amount ?? 0)),
    0,
  );

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

      {/* Tal for de seneste 30 dage */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <StatCard
          title="Nye brugere (30 dage)"
          value={newUsers ?? 0}
          icon="M18 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zM3 19.235v-.11a6.375 6.375 0 0112.75 0v.109A12.318 12.318 0 019.374 21c-2.331 0-4.512-.645-6.374-1.766z"
          color="#0ea5e9"
        />
        <StatCard
          title="Gennemførte handler (30 dage)"
          value={newTransactions ?? 0}
          icon="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5"
          color="#8b5cf6"
        />
      </div>
    </div>
  );
}
