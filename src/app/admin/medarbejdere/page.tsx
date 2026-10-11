import AdminActionKnap from "@/components/admin/AdminActionKnap";
import { orVaerdi } from "@/lib/postgrest";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getStaffRole } from "@/lib/adminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { setRolle } from "@/app/actions/adminActions";
import AdminFilters from "@/components/admin/AdminFilters";
import { RolleBadge } from "@/components/admin/StatusBadge";
import { BIDHAMR_SYSTEM_ID } from "@/lib/staffChat";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import { ADMIN_ERHVERV_EKSTRA } from "@/lib/tekster/erhverv";
import AdminSide from "@/components/admin/AdminSide";

export default async function AdminMedarbejdere({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const rolle = await getStaffRole();
  if (rolle !== "chef") {
    notFound();
  }

  const { q } = await searchParams;
  const supabase = createAdminClient();

  // Staff-listen (admins, medarbejdere og sælgere) vises altid; søgning finder alle
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
      .or(`navn.ilike.${orVaerdi(q)},email.ilike.${orVaerdi(q)}`)
      .neq("id", BIDHAMR_SYSTEM_ID)
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
      // Sælger (erhverv): kun Admin → Erhverv (henvendelser og firmaer).
      { rolle: "saelger", label: ADMIN_ERHVERV_EKSTRA.goerTilSaelger, klasse: "bg-emerald-100 text-emerald-800 hover:bg-emerald-200" },
      { rolle: "bruger", label: "Fjern rolle", klasse: "bg-neutral-100 text-tekst-daempet hover:bg-neutral-200" },
    ].filter((m) => m.rolle !== user.rolle);

    return (
      <div className="flex flex-wrap gap-2">
        {muligheder.map((m) => (
          <AdminActionKnap
            key={m.rolle}
            action={setRolle}
            hiddenFields={{ userId: user.id, rolle: m.rolle }}
            label={m.label}
            className={`px-2 py-1 text-xs rounded-md transition-colors ${m.klasse}`}
          />
        ))}
      </div>
    );
  };

  const tabel = (
    rows: NonNullable<typeof staff>,
    tomBesked: string,
  ) => (
    <div className="lg:overflow-hidden lg:rounded-[14px] lg:border lg:border-admin-kant lg:bg-white">
      <div className="lg:overflow-x-auto">
        <table className="block w-full text-sm lg:table">
          <thead className="hidden lg:table-header-group">
            <tr className="bg-neutral-50 text-xs text-tekst-svag uppercase">
              <th className="px-5 py-3 text-left font-medium">Navn</th>
              <th className="px-5 py-3 text-left font-medium">E-mail</th>
              <th className="px-5 py-3 text-left font-medium">Rolle</th>
              <th className="px-5 py-3 text-left font-medium">Oprettet</th>
              <th className="px-5 py-3 text-left font-medium">Handling</th>
            </tr>
          </thead>
          <tbody className="block space-y-3 lg:table-row-group lg:space-y-0 divide-y divide-admin-kant">
            {rows.map((user) => (
              <tr key={user.id} className="block rounded-[14px] border border-admin-kant bg-white p-4 lg:table-row lg:rounded-none lg:border-0 lg:p-0 hover:bg-neutral-50">
                <td className="block py-1 lg:table-cell lg:px-5 lg:py-3 font-medium text-tekst">{user.navn ?? "—"}</td>
                <td className="block py-1 lg:table-cell lg:px-5 lg:py-3 text-tekst-daempet">{user.email}</td>
                <td className="block py-1 lg:table-cell lg:px-5 lg:py-3"><RolleBadge rolle={user.rolle} /></td>
                <td className="block py-1 lg:table-cell lg:px-5 lg:py-3 text-tekst-svag">
                  {new Date(user.oprettet).toLocaleDateString("da-DK")}
                </td>
                <td className="block py-1 lg:table-cell lg:px-5 lg:py-3">{rolleKnapper(user)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-10 text-center text-tekst-svag">
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
    <AdminSide>
      <AdminSideHoved
        titel="Medarbejdere"
        forklaring="Hvem der har adgang til admin, og med hvilken rolle. Brug siden, når nogen starter eller stopper."
        hoejre={<span className="text-sm text-tekst-svag">{staff?.length ?? 0} med adgang</span>}
      />

      {tabel(staff ?? [], "Ingen medarbejdere endnu")}

      <div className="pt-4">
        <h2 className="text-lg font-semibold text-tekst">
          Tilføj medarbejder
        </h2>
        <p className="mt-1 text-sm text-tekst-svag">
          Søg en eksisterende bruger frem og giv dem medarbejder-rollen.
        </p>
        <div className="mt-3">
          <Suspense>
            <AdminFilters sortOptions={[]} searchPlaceholder="Søg på navn eller e-mail..." />
          </Suspense>
        </div>
      </div>

      {q && tabel(søgeresultater ?? [], `Ingen brugere matcher "${q}"`)}
    </AdminSide>
  );
}
