import { createClient } from "@/lib/supabase/server";
import { anonymUsername } from "@/lib/anonymUsername";
import { deleteRating } from "@/app/actions/adminActions";

export default async function AdminBedommelser() {
  const supabase = await createClient();

  const { data: ratings } = await supabase
    .from("ratings")
    .select("id, fra_bruger_id, til_bruger_id, stjerner, kommentar, oprettet")
    .order("oprettet", { ascending: false });

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
        <h1 className="text-2xl font-bold text-neutral-900">Bedømmelser</h1>
        <span className="text-sm text-neutral-500">{ratings?.length ?? 0} i alt</span>
      </div>

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
                  <td className="px-5 py-3">{stars(r.stjerner ?? 0)}</td>
                  <td className="px-5 py-3 text-neutral-600 max-w-[240px]">
                    <span className="line-clamp-2">{r.kommentar ?? "—"}</span>
                  </td>
                  <td className="px-5 py-3 text-neutral-500">
                    {new Date(r.oprettet).toLocaleDateString("da-DK")}
                  </td>
                  <td className="px-5 py-3">
                    <form action={deleteRating}>
                      <input type="hidden" name="ratingId" value={r.id} />
                      <button
                        type="submit"
                        className="px-2 py-1 text-xs bg-red-100 text-red-700 rounded-md hover:bg-red-200 transition-colors"
                      >
                        Slet
                      </button>
                    </form>
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
