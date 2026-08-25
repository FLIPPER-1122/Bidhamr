import { redirect } from "next/navigation";
import { Suspense } from "react";
import { getStaffRole } from "@/lib/adminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { setRolle } from "@/app/actions/adminActions";
import AdminFilters from "@/components/admin/AdminFilters";
import { RolleBadge } from "@/components/admin/StatusBadge";

export default async function AdminMedarbejdere({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const rolle = await getStaffRole();
  if (rolle !== "chef") {
    redirect("/admin/brugere");
  }

  const { q } = await searchParams;
  const supabase = createAdminClient();

  // Staff-listen (admins + medarbejdere) vises altid; søgning finder alle
  // brugere, så en almindelig bruger kan forfremmes.
  const { data: staff } = await supabase
    .from("users")
    .select("id, navn, email, rolle, oprettet")
    .neq("rolle", "bruger")
    .order("rolle", { ascending: true })
    .order("navn", { ascending: true });

  let søgeresultater: typeof staff = null;
  if (q) {
    const { data } = await supabase
      .from("users")
      .select("id, navn, email, rolle, oprettet")
      .or(`navn.ilike.%${q}%,email.ilike.%${q}%`)
      .order("navn", { ascending: true })
      .limit(20);
    søgeresultater = data;
  }

  // Chef kan tildele bruger/medarbejder/admin — men ikke røre andre chefer.
  const rolleKnapper = (user: { id: string; rolle: string }) => {
    if (user.rolle === "chef") return null;

    const muligheder: { rolle: string; label: string; klasse: string }[] = [
      { rolle: "medarbejder", label: "Gør til medarbejder", klasse: "bg-blue-100 text-blue-700 hover:bg-blue-200" },
      { rolle: "admin", label: "Gør til admin", klasse: "bg-purple-100 text-purple-700 hover:bg-purple-200" },
      { rolle: "bruger", label: "Fjern rolle", klasse: "bg-neutral-100 text-neutral-600 hover:bg-neutral-200" },
    ].filter((m) => m.rolle !== user.rolle);

    return (
      <div className="flex flex-wrap gap-2">
        {muligheder.map((m) => (
          <form key={m.rolle} action={setRolle}>
            <input type="hidden" name="userId" value={user.id} />
            <input type="hidden" name="rolle" value={m.rolle} />
            <button
              type="submit"
              className={`px-2 py-1 text-xs rounded-md transition-colors ${m.klasse}`}
            >
              {m.label}
            </button>
          </form>
        ))}
      </div>
    );
  };

  const tabel = (
    rows: NonNullable<typeof staff>,
    tomBesked: string,
  ) => (
    <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-neutral-50 text-xs text-neutral-500 uppercase">
              <th className="px-5 py-3 text-left font-medium">Navn</th>
              <th className="px-5 py-3 text-left font-medium">Email</th>
              <th className="px-5 py-3 text-left font-medium">Rolle</th>
              <th className="px-5 py-3 text-left font-medium">Oprettet</th>
              <th className="px-5 py-3 text-left font-medium">Handling</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {rows.map((user) => (
              <tr key={user.id} className="hover:bg-neutral-50">
                <td className="px-5 py-3 font-medium text-neutral-800">{user.navn ?? "—"}</td>
                <td className="px-5 py-3 text-neutral-600">{user.email}</td>
                <td className="px-5 py-3"><RolleBadge rolle={user.rolle} /></td>
                <td className="px-5 py-3 text-neutral-500">
                  {new Date(user.oprettet).toLocaleDateString("da-DK")}
                </td>
                <td className="px-5 py-3">{rolleKnapper(user)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-10 text-center text-neutral-400">
                  {tomBesked}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-neutral-900">Medarbejdere</h1>
        <span className="text-sm text-neutral-500">
          {staff?.length ?? 0} med adgang
        </span>
      </div>

      {tabel(staff ?? [], "Ingen medarbejdere endnu")}

      <div className="pt-4">
        <h2 className="text-lg font-semibold text-neutral-900">
          Tilføj medarbejder
        </h2>
        <p className="mt-1 text-sm text-neutral-500">
          Søg en eksisterende bruger frem og giv dem medarbejder-rollen.
        </p>
        <div className="mt-3">
          <Suspense>
            <AdminFilters sortOptions={[]} searchPlaceholder="Søg på navn eller email..." />
          </Suspense>
        </div>
      </div>

      {q && tabel(søgeresultater ?? [], `Ingen brugere matcher "${q}"`)}
    </div>
  );
}
