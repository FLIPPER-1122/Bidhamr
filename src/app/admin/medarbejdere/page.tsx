import AdminActionKnap from "@/components/admin/AdminActionKnap";
import { orVaerdi } from "@/lib/postgrest";
import { Suspense } from "react";
import { kraevSideRolle } from "@/lib/adminAuth";
import { adminVaertAktiv } from "@/lib/adminVaert";
import { FRISK_KODE_MINUTTER } from "@/lib/staffToTrinRegler";
import { nuMs } from "@/lib/dsa/regler";
import { aabnToTrinTilmelding, nulstilLoginLoft, nulstilToTrin } from "@/app/actions/adminToTrin";
import ToTrinHandling from "@/components/admin/ToTrinHandling";
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
  const chef = await kraevSideRolle("chef");

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

  // To-trins-login (kun med admin på egen host, ADMIN_VAERT).
  const toTrinSlaaetTil = adminVaertAktiv();
  type ToTrin = { bruger_id: string; aktiv: boolean; opsat_kl: string | null; tilmelding_aaben_til: string | null };
  const toTrin = new Map<string, ToTrin>();
  if (toTrinSlaaetTil && staff && staff.length > 0) {
    const { data } = await supabase
      .from("staff_to_trin")
      .select("bruger_id, aktiv, opsat_kl, tilmelding_aaben_til")
      .in("bruger_id", staff.map((u) => u.id));
    for (const r of (data ?? []) as ToTrin[]) toTrin.set(r.bruger_id, r);
  }
  // Chefens seneste kode fra app'en: er den over 15 minutter gammel, vises
  // kodefeltet med det samme.
  const nu = nuMs();
  const kraeverKode =
    chef.andetTrinSek === null || nu / 1000 - chef.andetTrinSek > FRISK_KODE_MINUTTER * 60;
  const dato = (iso: string) =>
    new Date(iso).toLocaleString("da-DK", {
      timeZone: "Europe/Copenhagen",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });

  const toTrinCelle = (user: { id: string; rolle: string; navn: string | null }) => {
    if (!toTrinSlaaetTil || user.rolle === "bruger") return null;
    const t = toTrin.get(user.id);
    const aabenTil = t?.tilmelding_aaben_til && new Date(t.tilmelding_aaben_til).getTime() > nu ? t.tilmelding_aaben_til : null;
    const status = t?.aktiv
      ? `Sat op${t.opsat_kl ? ` ${dato(t.opsat_kl)}` : ""}`
      : aabenTil
        ? `Ikke sat op – tilmelding åben til ${dato(aabenTil)}`
        : "Ikke sat op – tilmelding lukket";
    const egen = user.id === chef.userId;
    return (
      <div className="space-y-2">
        <p className={`text-xs ${t?.aktiv ? "text-succes-tekst" : "text-advarsel-tekst"}`}>{status}</p>
        {!egen && (
          <div className="flex flex-wrap gap-2">
            {t?.aktiv ? (
              <ToTrinHandling
                userId={user.id}
                navn={user.navn ?? "medarbejderen"}
                handling={nulstilToTrin}
                label="Nulstil to-trins-login"
                kvittering="To-trins-login er nulstillet. Medarbejderen har fået en mail."
                bekraeft="Nulstil to-trins-login for {navn}? Den gamle app-kode og gendannelseskoderne holder op med at virke, og der åbnes for en ny opsætning i 24 timer."
                kraeverKode={kraeverKode}
                farlig
              />
            ) : (
              <ToTrinHandling
                userId={user.id}
                navn={user.navn ?? "medarbejderen"}
                handling={aabnToTrinTilmelding}
                label={aabenTil ? "Forlæng tilmelding (24 t)" : "Åbn tilmelding (24 t)"}
                kvittering="Tilmeldingen er åben i 24 timer. Medarbejderen har fået en mail."
                kraeverKode={kraeverKode}
              />
            )}
            {/* Udvejen, hvis medarbejderen er spærret ude af loftet pr. e-mail
                på en ny enhed (20261102430000). */}
            <ToTrinHandling
              userId={user.id}
              navn={user.navn ?? "medarbejderen"}
              handling={nulstilLoginLoft}
              label="Nulstil login-loft"
              kvittering="Login-loftet er nulstillet. Medarbejderen kan logge ind de næste 30 minutter."
              bekraeft="Nulstil login-loftet for {navn}? Brug det, hvis medarbejderen ikke kan logge ind på grund af for mange forsøg. De næste 30 minutter gælder loftet pr. e-mail ikke for kontoen. Adgangskoden og koden fra app'en kræves stadig."
              kraeverKode={kraeverKode}
            />
          </div>
        )}
      </div>
    );
  };

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
    <div className="lg:overflow-hidden lg:rounded-none lg:border lg:border-admin-kant lg:bg-white">
      <div className="lg:overflow-x-auto">
        <table className="block w-full text-sm lg:table">
          <thead className="hidden lg:table-header-group">
            <tr className="bg-neutral-50 text-xs text-tekst-svag uppercase">
              <th className="px-5 py-3 text-left font-medium">Navn</th>
              <th className="px-5 py-3 text-left font-medium">E-mail</th>
              <th className="px-5 py-3 text-left font-medium">Rolle</th>
              <th className="px-5 py-3 text-left font-medium">Oprettet</th>
              {toTrinSlaaetTil && <th className="px-5 py-3 text-left font-medium">To-trins-login</th>}
              <th className="px-5 py-3 text-left font-medium">Handling</th>
            </tr>
          </thead>
          <tbody className="block space-y-3 lg:table-row-group lg:space-y-0 divide-y divide-admin-kant">
            {rows.map((user) => (
              <tr key={user.id} className="block rounded-none border border-admin-kant bg-white p-4 lg:table-row lg:rounded-none lg:border-0 lg:p-0 hover:bg-neutral-50">
                <td className="block py-1 lg:table-cell lg:px-5 lg:py-3 font-medium text-tekst">{user.navn ?? "—"}</td>
                <td className="block py-1 lg:table-cell lg:px-5 lg:py-3 text-tekst-daempet">{user.email}</td>
                <td className="block py-1 lg:table-cell lg:px-5 lg:py-3"><RolleBadge rolle={user.rolle} /></td>
                <td className="block py-1 lg:table-cell lg:px-5 lg:py-3 text-tekst-svag">
                  {new Date(user.oprettet).toLocaleDateString("da-DK")}
                </td>
                {toTrinSlaaetTil && (
                  <td className="block py-1 lg:table-cell lg:px-5 lg:py-3">{toTrinCelle(user)}</td>
                )}
                <td className="block py-1 lg:table-cell lg:px-5 lg:py-3">{rolleKnapper(user)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={toTrinSlaaetTil ? 6 : 5} className="px-5 py-10 text-center text-tekst-svag">
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
