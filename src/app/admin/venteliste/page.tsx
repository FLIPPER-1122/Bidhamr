import { notFound } from "next/navigation";
import { getStaffRole } from "@/lib/adminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import CsvExportButton from "@/components/admin/CsvExportButton";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import AdminSide from "@/components/admin/AdminSide";

export default async function AdminVenteliste() {
  const rolle = await getStaffRole();
  if (rolle !== "chef") {
    notFound();
  }

  const supabase = createAdminClient();

  const { data: venteliste, count } = await supabase
    .from("venteliste")
    .select("email, oprettet", { count: "exact" })
    .order("oprettet", { ascending: false });

  const exportData = (venteliste ?? []).map((v) => ({
    email: v.email,
    oprettet: v.oprettet,
  }));

  return (
    <AdminSide>
      <AdminSideHoved
        titel="Venteliste"
        forklaring="Folk, der har skrevet sig op til at høre, når BidHamr åbner. Hent listen som fil, hvis du skal skrive til dem."
        hoejre={<CsvExportButton data={exportData} />}
      />

      {/* Count card */}
      <div className="bg-white rounded-xl border border-admin-kant p-5 inline-flex items-center gap-4">
        <div className="w-12 h-12 rounded-xl bg-orange/10 flex items-center justify-center">
          <svg className="w-6 h-6" fill="none" stroke="var(--color-orange)" strokeWidth={1.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
          </svg>
        </div>
        <div>
          <p className="text-xs text-tekst-svag uppercase font-medium">Tilmeldte i alt</p>
          <p className="text-2xl font-bold text-tekst">{count ?? 0}</p>
        </div>
      </div>

      <div className="lg:overflow-hidden lg:rounded-none lg:border lg:border-admin-kant lg:bg-white">
        <table className="block w-full text-sm lg:table">
          <thead className="hidden lg:table-header-group">
            <tr className="bg-neutral-50 text-xs text-tekst-svag uppercase">
              <th className="px-5 py-3 text-left font-medium">E-mail</th>
              <th className="px-5 py-3 text-left font-medium">Tilmeldt</th>
            </tr>
          </thead>
          <tbody className="block space-y-3 lg:table-row-group lg:space-y-0 divide-y divide-admin-kant">
            {(venteliste ?? []).map((v, i) => (
              <tr key={i} className="block rounded-none border border-admin-kant bg-white p-4 lg:table-row lg:rounded-none lg:border-0 lg:p-0 hover:bg-neutral-50">
                <td className="block py-1 lg:table-cell lg:px-5 lg:py-3 text-tekst">{v.email}</td>
                <td className="block py-1 lg:table-cell lg:px-5 lg:py-3 text-tekst-svag">
                  {new Date(v.oprettet).toLocaleDateString("da-DK")}
                </td>
              </tr>
            ))}
            {(venteliste ?? []).length === 0 && (
              <tr>
                <td colSpan={2} className="px-5 py-10 text-center text-tekst-svag">
                  Ingen tilmeldinger endnu
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </AdminSide>
  );
}
