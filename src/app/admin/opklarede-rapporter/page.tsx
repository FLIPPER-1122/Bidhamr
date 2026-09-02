import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getStaffRole } from "@/lib/adminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import AdminSearchInput from "@/components/admin/AdminSearchInput";
import { kategoriLabel } from "@/lib/anmeldelseKategorier";
import { rapportGenaabn } from "@/app/actions/adminActions";

type OpklaretRapport = {
  id: string;
  auction_id: string;
  reporter_id: string;
  category: string;
  description: string | null;
  created_at: string;
  handled_by: string | null;
  handled_note: string | null;
  handled_at: string | null;
};

export default async function AdminOpklaredeRapporter({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const rolle = await getStaffRole();
  if (!rolle) {
    redirect("/");
  }

  const { q } = await searchParams;
  const søgetekst = q?.trim() ?? "";
  const supabase = createAdminClient();

  const { data: rapporter } = await supabase
    .from("reports")
    .select(
      "id, auction_id, reporter_id, category, description, created_at, handled_by, handled_note, handled_at",
    )
    .eq("status", "behandlet")
    .order("handled_at", { ascending: false })
    .limit(500);

  const alle = (rapporter ?? []) as OpklaretRapport[];

  const auktionIds = [...new Set(alle.map((r) => r.auction_id))];
  // Både anmelderen og den medarbejder der behandlede sagen skal slås op.
  const brugerIds = [
    ...new Set([
      ...alle.map((r) => r.reporter_id),
      ...alle.map((r) => r.handled_by).filter(Boolean) as string[],
    ]),
  ];

  const [{ data: auktioner }, { data: brugere }] = await Promise.all([
    auktionIds.length
      ? supabase.from("auctions").select("id, titel").in("id", auktionIds)
      : Promise.resolve({ data: [] as { id: string; titel: string }[] }),
    brugerIds.length
      ? supabase.from("users").select("id, navn, email").in("id", brugerIds)
      : Promise.resolve({ data: [] as { id: string; navn: string; email: string }[] }),
  ]);

  const titelMap: Record<string, string> = {};
  (auktioner ?? []).forEach((a) => {
    titelMap[a.id] = a.titel;
  });
  const brugerMap: Record<string, { navn: string | null; email: string }> = {};
  (brugere ?? []).forEach((u) => {
    brugerMap[u.id] = { navn: u.navn, email: u.email };
  });

  const rows = søgetekst
    ? alle.filter((r) => {
        const nål = søgetekst.toLowerCase();
        const anmelder = brugerMap[r.reporter_id];
        const behandler = r.handled_by ? brugerMap[r.handled_by] : undefined;
        return (
          (titelMap[r.auction_id] ?? "").toLowerCase().includes(nål) ||
          kategoriLabel(r.category).toLowerCase().includes(nål) ||
          (r.description ?? "").toLowerCase().includes(nål) ||
          (r.handled_note ?? "").toLowerCase().includes(nål) ||
          (anmelder?.navn ?? "").toLowerCase().includes(nål) ||
          (anmelder?.email ?? "").toLowerCase().includes(nål) ||
          (behandler?.navn ?? "").toLowerCase().includes(nål) ||
          (behandler?.email ?? "").toLowerCase().includes(nål)
        );
      })
    : alle;

  const brugerCelle = (id: string | null) => {
    if (!id) return <span className="text-neutral-400">—</span>;
    const b = brugerMap[id];
    if (!b) return <span className="text-neutral-400">—</span>;
    return (
      <Link href={`/admin/brugere/${id}`} className="block max-w-[160px] hover:underline">
        <span className="block truncate text-neutral-800">{b.navn ?? "Uden navn"}</span>
        <span className="block truncate text-xs text-neutral-500">{b.email}</span>
      </Link>
    );
  };

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-neutral-900">Opklarede rapporter</h1>
        <span className="text-sm text-neutral-500">
          {rows.length} {rows.length === 1 ? "rapport" : "rapporter"}
        </span>
      </div>

      <p className="text-sm text-neutral-500">
        Anmeldelser der er afsluttet uden handling. Åbne anmeldelser findes under{" "}
        <Link href="/admin/rapporter" className="font-medium text-brand hover:underline">
          Rapporter
        </Link>
        .
      </p>

      <Suspense>
        <AdminSearchInput placeholder="Søg på auktion, note, anmelder eller behandler..." />
      </Suspense>

      <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-neutral-50 text-xs text-neutral-500 uppercase">
                <th className="px-5 py-3 text-left font-medium">Auktion</th>
                <th className="px-5 py-3 text-left font-medium">Kategori</th>
                <th className="px-5 py-3 text-left font-medium">Beskrivelse</th>
                <th className="px-5 py-3 text-left font-medium">Anmelder</th>
                <th className="px-5 py-3 text-left font-medium">Dato</th>
                <th className="px-5 py-3 text-left font-medium">Behandlet af</th>
                <th className="px-5 py-3 text-left font-medium">Note</th>
                <th className="px-5 py-3 text-left font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-neutral-50 align-top">
                  <td className="px-5 py-3">
                    <Link
                      href={`/auktion/${r.auction_id}`}
                      className="font-medium text-neutral-800 hover:text-brand hover:underline"
                    >
                      {titelMap[r.auction_id] ?? "(slettet auktion)"}
                    </Link>
                  </td>
                  <td className="px-5 py-3 whitespace-nowrap text-neutral-700">
                    {kategoriLabel(r.category)}
                  </td>
                  <td className="px-5 py-3 text-neutral-600">
                    {r.description ? (
                      <span className="block max-w-[220px]">{r.description}</span>
                    ) : (
                      <span className="text-neutral-400">—</span>
                    )}
                  </td>
                  <td className="px-5 py-3">{brugerCelle(r.reporter_id)}</td>
                  <td className="px-5 py-3 whitespace-nowrap text-neutral-500">
                    {new Date(r.created_at).toLocaleDateString("da-DK")}
                  </td>
                  <td className="px-5 py-3">
                    {brugerCelle(r.handled_by)}
                    {r.handled_at && (
                      <span className="mt-0.5 block whitespace-nowrap text-xs text-neutral-400">
                        {new Date(r.handled_at).toLocaleDateString("da-DK")}
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-neutral-700">
                    {r.handled_note ? (
                      <span className="block max-w-[260px]">{r.handled_note}</span>
                    ) : (
                      <span className="text-neutral-400">—</span>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <form action={rapportGenaabn}>
                      <input type="hidden" name="rapportId" value={r.id} />
                      <button
                        type="submit"
                        className="whitespace-nowrap rounded-md bg-neutral-100 px-2 py-1 text-xs text-neutral-600 transition-colors hover:bg-neutral-200"
                      >
                        Genåbn
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-10 text-center text-neutral-400">
                    {søgetekst
                      ? `Ingen opklarede rapporter matcher "${søgetekst}"`
                      : "Der er endnu ingen opklarede rapporter"}
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
