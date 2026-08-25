import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  suspendUser,
  unsuspendUser,
  advarUser,
  deleteAuction,
  deleteRating,
} from "@/app/actions/adminActions";
import Avatar from "@/components/Avatar";
import ConfirmDialog from "@/components/admin/ConfirmDialog";
import { StatusBadge, brugerStatus, erSuspensionAktiv, RolleBadge } from "@/components/admin/StatusBadge";
import { getStaffRole, harMindstRolle } from "@/lib/adminAuth";
import type { BrugerAuktionRow } from "@/lib/adminRowTypes";

const FANER = [
  { id: "oversigt", label: "Oversigt" },
  { id: "auktioner", label: "Auktioner" },
  { id: "bud", label: "Bud" },
  { id: "anmeldelser", label: "Anmeldelser" },
  { id: "sager", label: "Sager" },
] as const;

type Fane = (typeof FANER)[number]["id"];

const stars = (n: number) => "★".repeat(n) + "☆".repeat(5 - n);

const statusBadge = (status: string) => {
  if (status === "aktiv") return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">Aktiv</span>;
  if (status === "afsluttet") return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-neutral-100 text-neutral-600">Afsluttet</span>;
  return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">Annulleret</span>;
};

export default async function AdminBrugerDetalje({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ fane?: string }>;
}) {
  const { id } = await params;
  const { fane: faneParam } = await searchParams;
  const fane: Fane = FANER.some((f) => f.id === faneParam)
    ? (faneParam as Fane)
    : "oversigt";

  const supabase = createAdminClient();
  const staffRolle = await getStaffRole();
  // Sletning af auktioner/anmeldelser kræver admin+; medarbejdere ser ikke knapperne.
  const kanModerereIndhold = !!staffRolle && harMindstRolle(staffRolle, "admin");

  const [{ data: user }, { data: advarsler }] = await Promise.all([
    supabase.from("users").select("*").eq("id", id).single(),
    supabase
      .from("advarsler")
      .select("id, aarsag, oprettet_kl, oprettet_af")
      .eq("bruger_id", id)
      .order("oprettet_kl", { ascending: false }),
  ]);

  if (!user) notFound();

  const suspensionAktiv = erSuspensionAktiv(user);
  const status = brugerStatus(user, advarsler?.length ?? 0);

  return (
    <div className="p-6 space-y-5 max-w-4xl mx-auto">
      <Link
        href="/admin/brugere"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-neutral-500 hover:text-neutral-800"
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        Tilbage til søgning
      </Link>

      {/* Header-kort */}
      <div className="rounded-xl border border-neutral-200 bg-white p-6">
        <div className="flex flex-wrap items-center gap-4">
          <Avatar url={user.avatar_url} navn={user.navn} size={64} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold text-neutral-900">
                {user.navn ?? "Uden navn"}
              </h1>
              {user.rolle && user.rolle !== "bruger" && (
                <RolleBadge rolle={user.rolle} />
              )}
              <StatusBadge status={status} />
            </div>
            <p className="mt-0.5 text-sm text-neutral-500">
              {user.email}
              {user.telefon ? ` · ${user.telefon}` : ""}
            </p>
          </div>
        </div>

        {suspensionAktiv && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            Kontoen er suspenderet{" "}
            {user.suspenderet_til
              ? `indtil d. ${new Date(user.suspenderet_til).toLocaleDateString("da-DK")}`
              : "permanent"}
            {user.suspenderet_aarsag && ` — Årsag: ${user.suspenderet_aarsag}`}
          </div>
        )}
        {user.suspenderet && !suspensionAktiv && (
          <div className="mt-4 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-500">
            Tidligere suspenderet (udløbet d.{" "}
            {new Date(user.suspenderet_til!).toLocaleDateString("da-DK")}). Brug
            &quot;Ophæv suspension&quot; for at rydde op.
          </div>
        )}

        {/* Handlingsknapper */}
        <div className="mt-4 flex flex-wrap gap-3">
          <ConfirmDialog
            triggerLabel="Send advarsel"
            triggerClassName="inline-flex items-center gap-2 rounded-lg bg-yellow-100 px-4 py-2.5 text-sm font-semibold text-yellow-800 hover:bg-yellow-200 transition-colors"
            triggerIcon={
              <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
            }
            title={`Er du sikker på, at du vil sende en advarsel til ${user.navn ?? "brugeren"}?`}
            description="Advarslen gemmes på brugerens profil og kan ses af alle medarbejdere."
            confirmLabel="Ja, send advarslen"
            action={advarUser}
            hiddenFields={{ userId: user.id }}
            aarsagField={{
              label: "Besked",
              placeholder: "Skriv hvad advarslen handler om...",
              required: true,
            }}
          />

          {user.rolle !== "admin" &&
            user.rolle !== "chef" &&
            (user.suspenderet ? (
              <ConfirmDialog
                triggerLabel="Ophæv suspension"
                triggerClassName="inline-flex items-center gap-2 rounded-lg bg-green-100 px-4 py-2.5 text-sm font-semibold text-green-800 hover:bg-green-200 transition-colors"
                triggerIcon={
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                }
                title="Er du sikker på, at du vil ophæve suspensionen?"
                description="Brugeren kan logge ind igen med det samme."
                confirmLabel="Ja, ophæv suspensionen"
                action={unsuspendUser}
                hiddenFields={{ userId: user.id }}
              />
            ) : (
              <ConfirmDialog
                triggerLabel="Suspendér konto"
                triggerIcon={
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                  </svg>
                }
                title={`Er du sikker på, at du vil suspendere ${user.navn ?? "brugeren"}?`}
                description="Brugeren kan ikke logge ind, så længe suspensionen er aktiv."
                confirmLabel="Ja, suspendér kontoen"
                action={suspendUser}
                hiddenFields={{ userId: user.id }}
                varighedField
                aarsagField={{
                  label: "Årsag",
                  placeholder: "Skriv hvorfor kontoen suspenderes (vises for brugeren ved login)...",
                  required: true,
                }}
              />
            ))}
        </div>
      </div>

      {/* Faner */}
      <div className="flex gap-1 overflow-x-auto border-b border-neutral-200">
        {FANER.map((f) => (
          <Link
            key={f.id}
            href={`?fane=${f.id}`}
            className={`shrink-0 border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
              fane === f.id
                ? "border-brand font-semibold text-brand"
                : "border-transparent text-neutral-500 hover:text-neutral-800"
            }`}
          >
            {f.label}
          </Link>
        ))}
      </div>

      {fane === "oversigt" && (
        <OversigtFane user={user} advarsler={advarsler ?? []} supabase={supabase} />
      )}
      {fane === "auktioner" && (
        <AuktionerFane userId={id} supabase={supabase} kanModerere={kanModerereIndhold} />
      )}
      {fane === "bud" && <BudFane userId={id} supabase={supabase} />}
      {fane === "anmeldelser" && (
        <AnmeldelserFane userId={id} supabase={supabase} kanModerere={kanModerereIndhold} />
      )}
      {fane === "sager" && (
        <div className="rounded-xl border border-neutral-200 bg-white p-10 text-center">
          <h2 className="text-lg font-semibold text-neutral-900">Kommer snart</h2>
          <p className="mt-1 text-sm text-neutral-500">
            Her vil du kunne se sager, der involverer brugeren.
          </p>
        </div>
      )}
    </div>
  );
}

type Admin = ReturnType<typeof createAdminClient>;

async function OversigtFane({
  user,
  advarsler,
  supabase,
}: {
  user: { id: string; rating: number | null; rolle: string | null; oprettet: string };
  advarsler: { id: string; aarsag: string; oprettet_kl: string; oprettet_af: string | null }[];
  supabase: Admin;
}) {
  const [{ count: antalAuktioner }, { count: antalBud }, { count: antalHandler }] =
    await Promise.all([
      supabase.from("auctions").select("id", { count: "exact", head: true }).eq("bruger_id", user.id),
      supabase.from("bids").select("id", { count: "exact", head: true }).eq("bruger_id", user.id),
      supabase
        .from("transactions")
        .select("id", { count: "exact", head: true })
        .or(`køber_id.eq.${user.id},sælger_id.eq.${user.id}`)
        .eq("status", "frigivet"),
    ]);

  const forfatterIds = [...new Set(advarsler.map((a) => a.oprettet_af).filter(Boolean))] as string[];
  const { data: forfattere } = forfatterIds.length
    ? await supabase.from("users").select("id, navn").in("id", forfatterIds)
    : { data: [] };
  const forfatterMap: Record<string, string> = {};
  (forfattere ?? []).forEach((f) => {
    forfatterMap[f.id] = f.navn;
  });

  const stat = (label: string, value: string | number) => (
    <div className="rounded-xl border border-neutral-200 bg-white p-4 text-center">
      <p className="text-2xl font-bold text-neutral-900">{value}</p>
      <p className="mt-0.5 text-xs font-medium uppercase text-neutral-500">{label}</p>
    </div>
  );

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stat("Rating", user.rating != null ? `${user.rating} ★` : "—")}
        {stat("Auktioner", antalAuktioner ?? 0)}
        {stat("Bud", antalBud ?? 0)}
        {stat("Gennemførte handler", antalHandler ?? 0)}
      </div>

      <div className="rounded-xl border border-neutral-200 bg-white p-5 text-sm">
        <p>
          <span className="text-neutral-500">Medlem siden:</span>{" "}
          <span className="font-medium text-neutral-800">
            {new Date(user.oprettet).toLocaleDateString("da-DK")}
          </span>
          <span className="ml-4 text-neutral-500">Rolle:</span>{" "}
          <span className="font-medium text-neutral-800">{user.rolle ?? "bruger"}</span>
        </p>
      </div>

      <div className="rounded-xl border border-neutral-200 bg-white overflow-hidden">
        <div className="border-b border-neutral-100 px-5 py-4">
          <h2 className="text-sm font-semibold text-neutral-800">
            Advarselshistorik ({advarsler.length})
          </h2>
        </div>
        <div className="divide-y divide-neutral-100">
          {advarsler.map((a) => (
            <div key={a.id} className="px-5 py-4">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium text-neutral-500">
                  {a.oprettet_af ? forfatterMap[a.oprettet_af] ?? "Ukendt" : "Ukendt"}
                </span>
                <span className="text-xs text-neutral-400">
                  {new Date(a.oprettet_kl).toLocaleDateString("da-DK")}
                </span>
              </div>
              <p className="text-sm text-neutral-700">{a.aarsag}</p>
            </div>
          ))}
          {advarsler.length === 0 && (
            <div className="px-5 py-6 text-center text-sm text-neutral-400">
              Ingen advarsler
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

async function AuktionerFane({
  userId,
  supabase,
  kanModerere,
}: {
  userId: string;
  supabase: Admin;
  kanModerere: boolean;
}) {
  const { data: auctions } = await supabase
    .from("auctions")
    .select("id, titel, status, oprettet, nuværende_bud")
    .eq("bruger_id", userId)
    .order("oprettet", { ascending: false })
    .overrideTypes<BrugerAuktionRow[], { merge: false }>();

  return (
    <div className="rounded-xl border border-neutral-200 bg-white overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-neutral-50 text-xs uppercase text-neutral-500">
            <th className="px-5 py-3 text-left font-medium">Titel</th>
            <th className="px-5 py-3 text-left font-medium">Status</th>
            <th className="px-5 py-3 text-left font-medium">Nuv. bud</th>
            <th className="px-5 py-3 text-left font-medium">Oprettet</th>
            <th className="px-5 py-3 text-left font-medium">Handling</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {(auctions ?? []).map((a) => (
            <tr key={a.id} className="hover:bg-neutral-50">
              <td className="px-5 py-3 text-neutral-700">{a.titel}</td>
              <td className="px-5 py-3">{statusBadge(a.status)}</td>
              <td className="px-5 py-3 text-neutral-600">
                {a["nuværende_bud"] != null ? `${a["nuværende_bud"]} kr` : "—"}
              </td>
              <td className="px-5 py-3 text-neutral-500">
                {new Date(a.oprettet).toLocaleDateString("da-DK")}
              </td>
              <td className="px-5 py-3">
                {kanModerere ? (
                  <ConfirmDialog
                    triggerLabel="Slet auktion"
                    triggerClassName="px-2 py-1 text-xs bg-red-100 text-red-700 rounded-md hover:bg-red-200 transition-colors"
                    title="Er du sikker på, at du vil slette auktionen?"
                    description="Handlingen kan ikke fortrydes."
                    confirmLabel="Ja, slet auktionen"
                    action={deleteAuction}
                    hiddenFields={{ auktionId: a.id }}
                    aarsagField={{
                      label: "Årsag",
                      placeholder: "Skriv hvorfor auktionen slettes...",
                      required: true,
                    }}
                  />
                ) : (
                  <span className="text-xs text-neutral-400">—</span>
                )}
              </td>
            </tr>
          ))}
          {(auctions ?? []).length === 0 && (
            <tr>
              <td colSpan={5} className="px-5 py-6 text-center text-neutral-400">
                Ingen auktioner
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

async function BudFane({ userId, supabase }: { userId: string; supabase: Admin }) {
  const { data: bud } = await supabase
    .from("bids")
    .select("id, auktion_id, oprettet, beløb")
    .eq("bruger_id", userId)
    .order("oprettet", { ascending: false })
    .limit(50)
    .overrideTypes<
      { id: string; auktion_id: string; oprettet: string; beløb: number }[],
      { merge: false }
    >();

  const auktionIds = [...new Set((bud ?? []).map((b) => b.auktion_id))];
  const { data: auktioner } = auktionIds.length
    ? await supabase.from("auctions").select("id, titel").in("id", auktionIds)
    : { data: [] };
  const titelMap: Record<string, string> = {};
  (auktioner ?? []).forEach((a) => {
    titelMap[a.id] = a.titel;
  });

  return (
    <div className="rounded-xl border border-neutral-200 bg-white overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-neutral-50 text-xs uppercase text-neutral-500">
            <th className="px-5 py-3 text-left font-medium">Auktion</th>
            <th className="px-5 py-3 text-left font-medium">Beløb</th>
            <th className="px-5 py-3 text-left font-medium">Tidspunkt</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {(bud ?? []).map((b) => (
            <tr key={b.id} className="hover:bg-neutral-50">
              <td className="px-5 py-3 text-neutral-700">
                {titelMap[b.auktion_id] ?? b.auktion_id}
              </td>
              <td className="px-5 py-3 text-neutral-600">
                {Number(b.beløb).toLocaleString("da-DK")} kr
              </td>
              <td className="px-5 py-3 text-neutral-500">
                {new Date(b.oprettet).toLocaleString("da-DK")}
              </td>
            </tr>
          ))}
          {(bud ?? []).length === 0 && (
            <tr>
              <td colSpan={3} className="px-5 py-6 text-center text-neutral-400">
                Ingen bud
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

async function AnmeldelserFane({
  userId,
  supabase,
  kanModerere,
}: {
  userId: string;
  supabase: Admin;
  kanModerere: boolean;
}) {
  const [{ data: modtagne }, { data: afgivne }] = await Promise.all([
    supabase
      .from("ratings")
      .select("id, stjerner, kommentar, oprettet, skjult")
      .eq("til_bruger_id", userId)
      .order("oprettet", { ascending: false }),
    supabase
      .from("ratings")
      .select("id, stjerner, kommentar, oprettet, skjult")
      .eq("fra_bruger_id", userId)
      .order("oprettet", { ascending: false }),
  ]);

  const liste = (
    titel: string,
    ratings: { id: string; stjerner: number | null; kommentar: string | null; oprettet: string; skjult: boolean }[],
  ) => (
    <div className="rounded-xl border border-neutral-200 bg-white overflow-hidden">
      <div className="border-b border-neutral-100 px-5 py-4">
        <h2 className="text-sm font-semibold text-neutral-800">
          {titel} ({ratings.length})
        </h2>
      </div>
      <div className="divide-y divide-neutral-100">
        {ratings.map((r) => (
          <div key={r.id} className="px-5 py-4">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-sm text-amber-500">
                {stars(r.stjerner ?? 0)}
                {r.skjult && (
                  <span className="ml-2 rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-500">
                    Skjult
                  </span>
                )}
              </span>
              <div className="flex items-center gap-3">
                <span className="text-xs text-neutral-400">
                  {new Date(r.oprettet).toLocaleDateString("da-DK")}
                </span>
                {kanModerere && (
                  <ConfirmDialog
                    triggerLabel="Slet anmeldelse"
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
                )}
              </div>
            </div>
            {r.kommentar && <p className="text-sm text-neutral-600">{r.kommentar}</p>}
          </div>
        ))}
        {ratings.length === 0 && (
          <div className="px-5 py-6 text-center text-sm text-neutral-400">
            Ingen anmeldelser
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-5">
      {liste("Modtagne anmeldelser", modtagne ?? [])}
      {liste("Afgivne anmeldelser", afgivne ?? [])}
    </div>
  );
}
