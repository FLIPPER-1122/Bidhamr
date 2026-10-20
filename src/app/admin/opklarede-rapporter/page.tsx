import AdminActionKnap from "@/components/admin/AdminActionKnap";
import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getStaffRole, harMindstRolle } from "@/lib/adminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import AdminSearchInput from "@/components/admin/AdminSearchInput";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import RapportFaner from "@/components/admin/RapportFaner";
import { kategoriLabel } from "@/lib/anmeldelseKategorier";
import { rapportGenaabn } from "@/app/actions/adminActions";
import AdminSide from "@/components/admin/AdminSide";

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
    if (!id) return <span className="text-tekst-svag">—</span>;
    const b = brugerMap[id];
    if (!b) return <span className="text-tekst-svag">—</span>;
    return (
      <Link href={`/admin/brugere/${id}`} className="block max-w-[160px] hover:underline">
        <span className="block truncate text-tekst">{b.navn ?? "Uden navn"}</span>
        <span className="block truncate text-xs text-tekst-svag">{b.email}</span>
      </Link>
    );
  };

  return (
    <AdminSide>
      <AdminSideHoved
        titel="Anmeldelser"
        forklaring="Anmeldelser, der er afsluttet uden at fjerne opslaget. Her kan du genåbne en, hvis der var en fejl."
        hoejre={
          <span className="text-sm text-tekst-svag">
            {rows.length} {rows.length === 1 ? "rapport" : "rapporter"}
          </span>
        }
      >
        <p className="mt-1 max-w-3xl text-xs text-tekst-svag">
          De flyttes til arkivet efter 48 timer (dog ikke, mens en handel eller sag på auktionen er
          i gang). I arkivet gemmes de for altid og kan ikke genåbnes.
        </p>
      </AdminSideHoved>

      <RapportFaner aktiv="opklarede" visArkiv={harMindstRolle(rolle, "admin")} />

      <Suspense>
        <AdminSearchInput placeholder="Søg på auktion, note, anmelder eller behandler..." />
      </Suspense>

      <div className="lg:overflow-hidden lg:rounded-[14px] lg:border lg:border-admin-kant lg:bg-white">
        <div className="lg:overflow-x-auto">
          <table className="block w-full text-sm lg:table">
            <thead className="hidden lg:table-header-group">
              <tr className="bg-neutral-50 text-xs text-tekst-svag uppercase">
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
            <tbody className="block space-y-3 lg:table-row-group lg:space-y-0 divide-y divide-admin-kant">
              {rows.map((r) => (
                <tr key={r.id} className="block rounded-[14px] border border-admin-kant bg-white p-4 lg:table-row lg:rounded-none lg:border-0 lg:p-0 hover:bg-neutral-50 align-top">
                  <td className="block py-1 lg:table-cell lg:px-5 lg:py-3">
                    <Link
                      href={`/admin/auktioner/${r.auction_id}`}
                      className="font-medium text-tekst hover:text-groen hover:underline"
                    >
                      {titelMap[r.auction_id] ?? "(slettet auktion)"}
                    </Link>
                  </td>
                  <td className="block py-1 lg:table-cell lg:px-5 lg:py-3 whitespace-nowrap text-tekst">
                    {kategoriLabel(r.category)}
                  </td>
                  <td className="block py-1 lg:table-cell lg:px-5 lg:py-3 text-tekst-daempet">
                    {r.description ? (
                      <span className="block max-w-[220px]">{r.description}</span>
                    ) : (
                      <span className="text-tekst-svag">—</span>
                    )}
                  </td>
                  <td className="block py-1 lg:table-cell lg:px-5 lg:py-3">{brugerCelle(r.reporter_id)}</td>
                  <td className="block py-1 lg:table-cell lg:px-5 lg:py-3 whitespace-nowrap text-tekst-svag">
                    {new Date(r.created_at).toLocaleDateString("da-DK")}
                  </td>
                  <td className="block py-1 lg:table-cell lg:px-5 lg:py-3">
                    {brugerCelle(r.handled_by)}
                    {r.handled_at && (
                      <span className="mt-0.5 block whitespace-nowrap text-xs text-tekst-svag">
                        {new Date(r.handled_at).toLocaleDateString("da-DK")}
                      </span>
                    )}
                  </td>
                  <td className="block py-1 lg:table-cell lg:px-5 lg:py-3 text-tekst">
                    {r.handled_note ? (
                      <span className="block max-w-[260px]">{r.handled_note}</span>
                    ) : (
                      <span className="text-tekst-svag">—</span>
                    )}
                  </td>
                  <td className="block py-1 lg:table-cell lg:px-5 lg:py-3">
                    <AdminActionKnap
                      action={rapportGenaabn}
                      hiddenFields={{ rapportId: r.id }}
                      label="Genåbn"
                      className="whitespace-nowrap rounded-md bg-neutral-100 px-2 py-1 text-xs text-tekst-daempet transition-colors hover:bg-neutral-200"
                    />
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-10 text-center text-tekst-svag">
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
    </AdminSide>
  );
}
