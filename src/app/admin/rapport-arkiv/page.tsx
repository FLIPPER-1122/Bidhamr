import Link from "next/link";
import { kraevSideRolle } from "@/lib/adminAuth";
import { kategoriLabel } from "@/lib/anmeldelseKategorier";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import RapportFaner from "@/components/admin/RapportFaner";
import AdminSide from "@/components/admin/AdminSide";

// Rapportarkiv: behandlede anmeldelser flyttes hertil af den automatiske
// oprydning 48 timer efter behandling. De gemmes permanent (DSA-dokumentation)
// og kan hverken ændres, slettes eller genåbnes. Kun admin og chef.

const PR_SIDE = 50;

type ArkiveretRapport = {
  id: string;
  auction_id: string;
  reporter_id: string;
  category: string;
  description: string | null;
  created_at: string;
  status: string;
  handled_by: string | null;
  handled_note: string | null;
  handled_at: string | null;
  arkiveret_kl: string;
};

const UDFALD: Record<string, string> = {
  behandlet: "Afsluttet uden handling",
  fjernet: "Opslag fjernet",
  under_behandling: "Under behandling",
  pending: "Afventer",
};

export default async function AdminRapportArkiv({
  searchParams,
}: {
  searchParams: Promise<{ side?: string }>;
}) {
  const { admin } = await kraevSideRolle("admin");
  const { side: sideParam } = await searchParams;
  const side = Math.max(1, Math.floor(Number(sideParam)) || 1);

  const { data, count, error } = await admin
    .from("rapporter_arkiv")
    .select(
      "id, auction_id, reporter_id, category, description, created_at, status, handled_by, handled_note, handled_at, arkiveret_kl",
      { count: "exact" },
    )
    .order("arkiveret_kl", { ascending: false })
    .order("id", { ascending: false })
    .range((side - 1) * PR_SIDE, side * PR_SIDE - 1);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as ArkiveretRapport[];

  const auktionIds = [...new Set(rows.map((r) => r.auction_id))];
  const brugerIds = [
    ...new Set([
      ...rows.map((r) => r.reporter_id),
      ...(rows.map((r) => r.handled_by).filter(Boolean) as string[]),
    ]),
  ];

  const [{ data: auktioner }, { data: brugere }] = await Promise.all([
    auktionIds.length
      ? admin.from("auctions").select("id, titel").in("id", auktionIds)
      : Promise.resolve({ data: [] as { id: string; titel: string }[] }),
    brugerIds.length
      ? admin.from("users").select("id, navn, email").in("id", brugerIds)
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

  const antal = count ?? 0;
  const antalSider = Math.max(1, Math.ceil(antal / PR_SIDE));

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
        forklaring="Gamle, afsluttede anmeldelser. De gemmes for altid som dokumentation og kan ikke ændres eller genåbnes."
        hoejre={
          <span className="text-sm text-tekst-svag">
            {antal} {antal === 1 ? "rapport" : "rapporter"}
          </span>
        }
      />

      <RapportFaner aktiv="arkiv" visArkiv />

      <div className="lg:overflow-hidden lg:rounded-none lg:border lg:border-admin-kant lg:bg-white">
        <div className="lg:overflow-x-auto">
          <table className="block w-full text-sm lg:table">
            <thead className="hidden lg:table-header-group">
              <tr className="bg-neutral-50 text-xs text-tekst-svag uppercase">
                <th className="px-5 py-3 text-left font-medium">Auktion</th>
                <th className="px-5 py-3 text-left font-medium">Kategori</th>
                <th className="px-5 py-3 text-left font-medium">Beskrivelse</th>
                <th className="px-5 py-3 text-left font-medium">Anmelder</th>
                <th className="px-5 py-3 text-left font-medium">Dato</th>
                <th className="px-5 py-3 text-left font-medium">Udfald</th>
                <th className="px-5 py-3 text-left font-medium">Behandlet af</th>
                <th className="px-5 py-3 text-left font-medium">Note</th>
                <th className="px-5 py-3 text-left font-medium">Arkiveret</th>
              </tr>
            </thead>
            <tbody className="block space-y-3 lg:table-row-group lg:space-y-0 divide-y divide-admin-kant">
              {rows.map((r) => (
                <tr key={r.id} className="block rounded-none border border-admin-kant bg-white p-4 lg:table-row lg:rounded-none lg:border-0 lg:p-0 hover:bg-neutral-50 align-top">
                  <td className="block py-1 lg:table-cell lg:px-5 lg:py-3">
                    <Link
                      href={`/admin/auktioner/${r.auction_id}`}
                      className="font-medium text-tekst hover:text-groen hover:underline"
                    >
                      {titelMap[r.auction_id] ?? "(ukendt auktion)"}
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
                  <td className="block py-1 lg:table-cell lg:px-5 lg:py-3 whitespace-nowrap text-tekst">
                    {UDFALD[r.status] ?? r.status}
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
                  <td className="block py-1 lg:table-cell lg:px-5 lg:py-3 whitespace-nowrap text-tekst-svag">
                    {new Date(r.arkiveret_kl).toLocaleDateString("da-DK")}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-5 py-10 text-center text-tekst-svag">
                    {side > 1 ? "Ingen rapporter på denne side" : "Arkivet er tomt"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {antalSider > 1 && (
        <div className="flex items-center justify-between text-sm">
          {side > 1 ? (
            <Link href={`/admin/rapport-arkiv?side=${side - 1}`} className="text-tekst hover:underline">
              ← Forrige
            </Link>
          ) : (
            <span />
          )}
          <span className="text-tekst-svag">
            Side {side} af {antalSider}
          </span>
          {side < antalSider ? (
            <Link href={`/admin/rapport-arkiv?side=${side + 1}`} className="text-tekst hover:underline">
              Næste →
            </Link>
          ) : (
            <span />
          )}
        </div>
      )}
    </AdminSide>
  );
}
