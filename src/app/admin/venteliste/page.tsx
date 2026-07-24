import { createClient } from "@/lib/supabase/server";
import CsvExportButton from "@/components/admin/CsvExportButton";

export default async function AdminVenteliste() {
  const supabase = await createClient();

  const { data: venteliste, count } = await supabase
    .from("venteliste")
    .select("email, oprettet", { count: "exact" })
    .order("oprettet", { ascending: false });

  const exportData = (venteliste ?? []).map((v) => ({
    email: v.email,
    oprettet: v.oprettet,
  }));

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-neutral-900">Venteliste</h1>
        <CsvExportButton data={exportData} />
      </div>

      {/* Count card */}
      <div className="bg-white rounded-xl border border-neutral-200 p-5 inline-flex items-center gap-4">
        <div className="w-12 h-12 rounded-xl bg-[#E6394618] flex items-center justify-center">
          <svg className="w-6 h-6" fill="none" stroke="#E63946" strokeWidth={1.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
          </svg>
        </div>
        <div>
          <p className="text-xs text-neutral-500 uppercase font-medium">Tilmeldte i alt</p>
          <p className="text-2xl font-bold text-neutral-900">{count ?? 0}</p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-neutral-50 text-xs text-neutral-500 uppercase">
              <th className="px-5 py-3 text-left font-medium">Email</th>
              <th className="px-5 py-3 text-left font-medium">Tilmeldt</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {(venteliste ?? []).map((v, i) => (
              <tr key={i} className="hover:bg-neutral-50">
                <td className="px-5 py-3 text-neutral-700">{v.email}</td>
                <td className="px-5 py-3 text-neutral-500">
                  {new Date(v.oprettet).toLocaleDateString("da-DK")}
                </td>
              </tr>
            ))}
            {(venteliste ?? []).length === 0 && (
              <tr>
                <td colSpan={2} className="px-5 py-10 text-center text-neutral-400">
                  Ingen tilmeldinger endnu
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
