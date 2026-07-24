import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { suspendUser } from "@/app/actions/adminActions";

export default async function AdminBrugerDetalje({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: user }, { data: auctions }, { data: ratings }] = await Promise.all([
    supabase.from("users").select("*").eq("id", id).single(),
    supabase.from("auctions").select("id, titel, status, oprettet, nuværende_bud").eq("bruger_id", id).order("oprettet", { ascending: false }),
    supabase.from("ratings").select("stjerner, kommentar, oprettet, fra_bruger_id").eq("til_bruger_id", id).order("oprettet", { ascending: false }),
  ]);

  if (!user) notFound();

  const statusBadge = (status: string) => {
    if (status === "aktiv") return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">Aktiv</span>;
    if (status === "afsluttet") return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-neutral-100 text-neutral-600">Afsluttet</span>;
    return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">Annulleret</span>;
  };

  const stars = (n: number) => "★".repeat(n) + "☆".repeat(5 - n);

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold text-neutral-900">Bruger: {user.navn ?? user.email}</h1>

      {/* Profile card */}
      <div className="bg-white rounded-xl border border-neutral-200 p-6 space-y-3">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-xs text-neutral-500 uppercase font-medium mb-1">Navn</p>
            <p className="text-neutral-800 font-medium">{user.navn ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs text-neutral-500 uppercase font-medium mb-1">Email</p>
            <p className="text-neutral-800">{user.email}</p>
          </div>
          <div>
            <p className="text-xs text-neutral-500 uppercase font-medium mb-1">Telefon</p>
            <p className="text-neutral-800">{user.telefon ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs text-neutral-500 uppercase font-medium mb-1">Rating</p>
            <p className="text-neutral-800">{user.rating != null ? `${user.rating} ★` : "—"}</p>
          </div>
          <div>
            <p className="text-xs text-neutral-500 uppercase font-medium mb-1">Rolle</p>
            <p className="text-neutral-800">{user.rolle ?? "bruger"}</p>
          </div>
          <div>
            <p className="text-xs text-neutral-500 uppercase font-medium mb-1">Oprettet</p>
            <p className="text-neutral-800">{new Date(user.oprettet).toLocaleDateString("da-DK")}</p>
          </div>
        </div>

        {user.rolle !== "suspenderet" && user.rolle !== "admin" && (
          <form action={suspendUser} className="pt-2">
            <input type="hidden" name="userId" value={user.id} />
            <button
              type="submit"
              className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors font-medium"
            >
              Suspendér konto
            </button>
          </form>
        )}
        {user.rolle === "suspenderet" && (
          <p className="text-sm text-red-600 font-medium">Denne konto er suspenderet.</p>
        )}
      </div>

      {/* Auctions */}
      <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-neutral-100">
          <h2 className="font-semibold text-neutral-800 text-sm">Auktioner ({auctions?.length ?? 0})</h2>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-neutral-50 text-xs text-neutral-500 uppercase">
              <th className="px-5 py-3 text-left font-medium">Titel</th>
              <th className="px-5 py-3 text-left font-medium">Status</th>
              <th className="px-5 py-3 text-left font-medium">Nuv. bud</th>
              <th className="px-5 py-3 text-left font-medium">Oprettet</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {(auctions ?? []).map((a) => (
              <tr key={a.id} className="hover:bg-neutral-50">
                <td className="px-5 py-3 text-neutral-700">{a.titel}</td>
                <td className="px-5 py-3">{statusBadge(a.status)}</td>
                <td className="px-5 py-3 text-neutral-600">{a["nuværende_bud"] != null ? `${a["nuværende_bud"]} kr` : "—"}</td>
                <td className="px-5 py-3 text-neutral-500">{new Date(a.oprettet).toLocaleDateString("da-DK")}</td>
              </tr>
            ))}
            {(auctions ?? []).length === 0 && (
              <tr><td colSpan={4} className="px-5 py-6 text-center text-neutral-400">Ingen auktioner</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Ratings */}
      <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-neutral-100">
          <h2 className="font-semibold text-neutral-800 text-sm">Modtagne bedømmelser ({ratings?.length ?? 0})</h2>
        </div>
        <div className="divide-y divide-neutral-100">
          {(ratings ?? []).map((r, i) => (
            <div key={i} className="px-5 py-4">
              <div className="flex items-center justify-between mb-1">
                <span className="text-amber-500 text-sm">{stars(r.stjerner ?? 0)}</span>
                <span className="text-xs text-neutral-400">{new Date(r.oprettet).toLocaleDateString("da-DK")}</span>
              </div>
              {r.kommentar && <p className="text-sm text-neutral-600">{r.kommentar}</p>}
            </div>
          ))}
          {(ratings ?? []).length === 0 && (
            <div className="px-5 py-6 text-center text-neutral-400 text-sm">Ingen bedømmelser</div>
          )}
        </div>
      </div>
    </div>
  );
}
