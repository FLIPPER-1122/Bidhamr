import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import AdminFilters from "@/components/admin/AdminFilters";
import { Suspense } from "react";

const sortOptions = [
  { value: "oprettet", label: "Oprettelsesdato" },
  { value: "navn", label: "Navn" },
  { value: "rating", label: "Rating" },
];

export default async function AdminBrugere({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; sort?: string }>;
}) {
  const { q, sort } = await searchParams;
  const supabase = await createClient();

  let query = supabase.from("users").select("id, navn, email, telefon, rating, rolle, oprettet");

  if (q) {
    query = query.or(`navn.ilike.%${q}%,email.ilike.%${q}%`);
  }

  if (sort === "navn") {
    query = query.order("navn", { ascending: true });
  } else if (sort === "rating") {
    query = query.order("rating", { ascending: false });
  } else {
    query = query.order("oprettet", { ascending: false });
  }

  const { data: users } = await query;

  // Fetch auction counts for all users
  const { data: auctionCounts } = await supabase
    .from("auctions")
    .select("bruger_id");

  const countMap: Record<string, number> = {};
  (auctionCounts ?? []).forEach((a) => {
    countMap[a.bruger_id] = (countMap[a.bruger_id] ?? 0) + 1;
  });

  const rolleBadge = (rolle: string) => {
    if (rolle === "admin") return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700">Admin</span>;
    if (rolle === "suspenderet") return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">Suspenderet</span>;
    return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-neutral-100 text-neutral-600">Bruger</span>;
  };

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-neutral-900">Brugere</h1>
        <span className="text-sm text-neutral-500">{users?.length ?? 0} brugere</span>
      </div>

      <Suspense>
        <AdminFilters sortOptions={sortOptions} searchPlaceholder="Søg på navn eller email..." />
      </Suspense>

      <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-neutral-50 text-xs text-neutral-500 uppercase divide-x divide-neutral-100">
                <th className="px-5 py-3 text-left font-medium">Navn</th>
                <th className="px-5 py-3 text-left font-medium">Email</th>
                <th className="px-5 py-3 text-left font-medium">Telefon</th>
                <th className="px-5 py-3 text-left font-medium">Rating</th>
                <th className="px-5 py-3 text-left font-medium">Auktioner</th>
                <th className="px-5 py-3 text-left font-medium">Oprettet</th>
                <th className="px-5 py-3 text-left font-medium">Rolle</th>
                <th className="px-5 py-3 text-left font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {(users ?? []).map((user) => (
                <tr key={user.id} className="hover:bg-neutral-50">
                  <td className="px-5 py-3 font-medium text-neutral-800">{user.navn ?? "—"}</td>
                  <td className="px-5 py-3 text-neutral-600">{user.email}</td>
                  <td className="px-5 py-3 text-neutral-500">{user.telefon ?? "—"}</td>
                  <td className="px-5 py-3 text-neutral-600">{user.rating != null ? `${user.rating} ★` : "—"}</td>
                  <td className="px-5 py-3 text-neutral-600">{countMap[user.id] ?? 0}</td>
                  <td className="px-5 py-3 text-neutral-500">{new Date(user.oprettet).toLocaleDateString("da-DK")}</td>
                  <td className="px-5 py-3">{rolleBadge(user.rolle ?? "bruger")}</td>
                  <td className="px-5 py-3">
                    <Link
                      href={`/admin/brugere/${user.id}`}
                      className="text-[#E63946] hover:underline text-xs font-medium"
                    >
                      Detaljer
                    </Link>
                  </td>
                </tr>
              ))}
              {(users ?? []).length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-10 text-center text-neutral-400">
                    Ingen brugere fundet
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
