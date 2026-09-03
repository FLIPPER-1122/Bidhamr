import Link from "next/link";
import { redirect } from "next/navigation";
import { getStaffRole } from "@/lib/adminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { kindLabel, kr } from "@/lib/wallet";

// Viser hovedbogen for e-money. Escrow-tabellen `transactions` bruges ikke
// laengere - penge flyttes nu mellem brugerkonti ved auktionsluk.
type EntryRow = {
  id: string;
  user_id: string;
  amount: number;
  kind: string;
  auction_id: string | null;
  note: string | null;
  created_at: string;
};

const KIND_FARVE: Record<string, string> = {
  indbetaling: "bg-green-100 text-green-800",
  koeb: "bg-blue-100 text-blue-800",
  salg: "bg-blue-100 text-blue-800",
  koebergebyr: "bg-yellow-100 text-yellow-800",
  saelgergebyr: "bg-yellow-100 text-yellow-800",
  justering: "bg-neutral-200 text-neutral-800",
};

export default async function AdminTransaktioner() {
  const rolle = await getStaffRole();
  if (rolle !== "chef") {
    redirect("/admin/brugere");
  }

  const supabase = createAdminClient();

  const { data: entriesData } = await supabase
    .from("wallet_entries")
    .select("id, user_id, amount, kind, auction_id, note, created_at")
    .order("created_at", { ascending: false })
    .limit(500);

  const entries = (entriesData ?? []) as EntryRow[];

  const brugerIds = [...new Set(entries.map((e) => e.user_id))];
  const auktionIds = [
    ...new Set(entries.map((e) => e.auction_id).filter(Boolean)),
  ] as string[];

  const [{ data: brugere }, { data: auktioner }] = await Promise.all([
    brugerIds.length
      ? supabase.from("users").select("id, navn, email").in("id", brugerIds)
      : Promise.resolve({ data: [] as { id: string; navn: string | null; email: string }[] }),
    auktionIds.length
      ? supabase.from("auctions").select("id, titel").in("id", auktionIds)
      : Promise.resolve({ data: [] as { id: string; titel: string }[] }),
  ]);

  const brugerMap: Record<string, { navn: string | null; email: string }> = {};
  (brugere ?? []).forEach((u) => {
    brugerMap[u.id] = { navn: u.navn, email: u.email };
  });
  const titelMap: Record<string, string> = {};
  (auktioner ?? []).forEach((a) => {
    titelMap[a.id] = a.titel;
  });

  const indbetalt = entries
    .filter((e) => e.kind === "indbetaling")
    .reduce((s, e) => s + Number(e.amount), 0);

  const gebyrIndtaegt = entries
    .filter((e) => e.kind === "koebergebyr" || e.kind === "saelgergebyr")
    .reduce((s, e) => s + Math.abs(Number(e.amount)), 0);

  const { data: saldi } = await supabase.from("wallets").select("balance");
  const samletIndestaaende = (saldi ?? []).reduce(
    (s, w) => s + Number(w.balance ?? 0),
    0,
  );

  return (
    <div className="space-y-5 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-neutral-900">Kontobevægelser</h1>
        <span className="text-sm text-neutral-500">
          {entries.length} seneste linjer
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-neutral-200 bg-white p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Indbetalt i alt
          </p>
          <p className="mt-1 text-2xl font-bold text-neutral-900">
            {kr(indbetalt)}
          </p>
        </div>
        <div className="rounded-xl border border-neutral-200 bg-white p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Gebyrindtægt
          </p>
          <p className="mt-1 text-2xl font-bold text-neutral-900">
            {kr(gebyrIndtaegt)}
          </p>
        </div>
        <div className="rounded-xl border border-brand bg-red-50 p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-brand">
            Brugernes indestående
          </p>
          <p className="mt-1 text-2xl font-bold text-neutral-900">
            {kr(samletIndestaaende)}
          </p>
          <p className="mt-1 text-xs text-neutral-600">
            Beløb BidHamr skylder brugerne
          </p>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-neutral-50 text-xs uppercase text-neutral-500">
                <th className="px-5 py-3 text-left font-medium">Dato</th>
                <th className="px-5 py-3 text-left font-medium">Bruger</th>
                <th className="px-5 py-3 text-left font-medium">Type</th>
                <th className="px-5 py-3 text-left font-medium">Auktion</th>
                <th className="px-5 py-3 text-right font-medium">Beløb</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {entries.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-5 py-10 text-center text-neutral-500"
                  >
                    Der er endnu ingen kontobevægelser.
                  </td>
                </tr>
              )}
              {entries.map((e) => {
                const bruger = brugerMap[e.user_id];
                const beløb = Number(e.amount);
                return (
                  <tr key={e.id} className="hover:bg-neutral-50">
                    <td className="whitespace-nowrap px-5 py-3 text-neutral-500">
                      {new Date(e.created_at).toLocaleDateString("da-DK")}
                    </td>
                    <td className="px-5 py-3">
                      {bruger ? (
                        <Link
                          href={`/admin/brugere/${e.user_id}`}
                          className="block max-w-[180px] hover:underline"
                        >
                          <span className="block truncate text-neutral-800">
                            {bruger.navn ?? "Uden navn"}
                          </span>
                          <span className="block truncate text-xs text-neutral-500">
                            {bruger.email}
                          </span>
                        </Link>
                      ) : (
                        <span className="text-neutral-400">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${
                          KIND_FARVE[e.kind] ?? "bg-neutral-200 text-neutral-800"
                        }`}
                      >
                        {kindLabel(e.kind)}
                      </span>
                      {e.note && (
                        <span className="mt-0.5 block max-w-[240px] truncate text-xs text-neutral-500">
                          {e.note}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      {e.auction_id ? (
                        <Link
                          href={`/auktion/${e.auction_id}`}
                          className="block max-w-[200px] truncate text-neutral-700 hover:text-brand hover:underline"
                        >
                          {titelMap[e.auction_id] ?? "(slettet)"}
                        </Link>
                      ) : (
                        <span className="text-neutral-400">—</span>
                      )}
                    </td>
                    <td
                      className={`whitespace-nowrap px-5 py-3 text-right font-medium ${
                        beløb < 0 ? "text-neutral-800" : "text-green-700"
                      }`}
                    >
                      {beløb > 0 ? "+" : ""}
                      {kr(beløb)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
