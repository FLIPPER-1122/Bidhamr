import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getStaffRole, harMindstRolle } from "@/lib/adminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { anonymUsername } from "@/lib/anonymUsername";
import { deleteRating, hideRating, unhideRating } from "@/app/actions/adminActions";
import AdminSearchInput from "@/components/admin/AdminSearchInput";
import ConfirmDialog from "@/components/admin/ConfirmDialog";

export default async function AdminBedommelser({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const rolle = await getStaffRole();
  if (!rolle || !harMindstRolle(rolle, "admin")) {
    redirect("/admin/brugere");
  }

  const { q } = await searchParams;
  const supabase = createAdminClient();

  let query = supabase
    .from("ratings")
    .select("id, fra_bruger_id, til_bruger_id, stjerner, kommentar, oprettet, skjult")
    .order("oprettet", { ascending: false });

  if (q) {
    query = query.ilike("kommentar", `%${q}%`);
  }

  const { data: ratings } = await query;

  const stars = (n: number) => {
    return (
      <span className="text-amber-400">
        {"★".repeat(n)}
        <span className="text-neutral-300">{"★".repeat(5 - n)}</span>
      </span>
    );
  };

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-neutral-900">Alle anmeldelser</h1>
        <span className="text-sm text-neutral-500">{ratings?.length ?? 0} i alt</span>
      </div>

      <Suspense>
        <AdminSearchInput placeholder="Søg i anmeldelsernes tekst..." />
      </Suspense>

      <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-neutral-50 text-xs text-neutral-500 uppercase">
                <th className="px-5 py-3 text-left font-medium">Fra</th>
                <th className="px-5 py-3 text-left font-medium">Til</th>
                <th className="px-5 py-3 text-left font-medium">Stjerner</th>
                <th className="px-5 py-3 text-left font-medium">Kommentar</th>
                <th className="px-5 py-3 text-left font-medium">Dato</th>
                <th className="px-5 py-3 text-left font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {(ratings ?? []).map((r) => (
                <tr key={r.id} className="hover:bg-neutral-50">
                  <td className="px-5 py-3 text-neutral-600 font-mono text-xs">
                    {anonymUsername(r.fra_bruger_id)}
                  </td>
                  <td className="px-5 py-3 text-neutral-600 font-mono text-xs">
                    {anonymUsername(r.til_bruger_id)}
                  </td>
                  <td className="px-5 py-3">
                    <span className="inline-flex items-center gap-1.5">
                      {stars(r.stjerner ?? 0)}
                      {r.skjult && (
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-neutral-200 text-neutral-600">Skjult</span>
                      )}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-neutral-600 max-w-[240px]">
                    <span className="line-clamp-2">{r.kommentar ?? "—"}</span>
                  </td>
                  <td className="px-5 py-3 text-neutral-500">
                    {new Date(r.oprettet).toLocaleDateString("da-DK")}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex gap-2">
                      <ConfirmDialog
                        triggerLabel={r.skjult ? "Vis igen" : "Skjul"}
                        triggerClassName="px-2 py-1 text-xs bg-neutral-100 text-neutral-600 rounded-md hover:bg-neutral-200 transition-colors"
                        title={
                          r.skjult
                            ? "Er du sikker på, at du vil vise anmeldelsen igen?"
                            : "Er du sikker på, at du vil skjule anmeldelsen?"
                        }
                        description={
                          r.skjult
                            ? "Anmeldelsen bliver synlig på profilen igen."
                            : "Anmeldelsen bliver usynlig på profilen, men slettes ikke."
                        }
                        confirmLabel={r.skjult ? "Ja, vis anmeldelsen" : "Ja, skjul anmeldelsen"}
                        action={r.skjult ? unhideRating : hideRating}
                        hiddenFields={{ ratingId: r.id }}
                      />
                      <ConfirmDialog
                        triggerLabel="Slet"
                        triggerClassName="px-2 py-1 text-xs bg-red-100 text-red-700 rounded-md hover:bg-red-200 transition-colors"
                        title="Er du sikker på, at du vil slette anmeldelsen?"
                        description="Handlingen kan ikke fortrydes."
                        confirmLabel="Ja, slet anmeldelsen"
                        action={deleteRating}
                        hiddenFields={{ ratingId: r.id }}
                        aarsagField={{
                          label: "Årsag",
                          placeholder: "Skriv hvorfor anmeldelsen slettes...",
                          required: true,
                        }}
                      />
                    </div>
                  </td>
                </tr>
              ))}
              {(ratings ?? []).length === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-10 text-center text-neutral-400">
                    Ingen bedømmelser endnu
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
