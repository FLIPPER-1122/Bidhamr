import Link from "next/link";
import { Suspense } from "react";
import Avatar from "@/components/Avatar";
import BrugerSearch from "@/components/admin/BrugerSearch";
import BrugereFaner from "@/components/admin/BrugereFaner";
import { StatusBadge, brugerStatus, RolleBadge } from "@/components/admin/StatusBadge";
import { assertRole } from "@/lib/adminAuth";
import AdminSideHoved from "@/components/admin/AdminSideHoved";

// Brugere og sikkerhed: søgning på navn, e-mail, telefon og bruger-id med
// filtre. Data via admin_brugere_soeg (service_role) efter assertRole.

const FILTRE = [
  { id: "", label: "Alle" },
  { id: "suspenderet", label: "Suspenderet" },
  { id: "lukket", label: "Lukket" },
  { id: "advarsler", label: "Har advarsler" },
  { id: "paamindelser", label: "Har påmindelser" },
  { id: "staff", label: "Staff" },
] as const;

type FilterId = (typeof FILTRE)[number]["id"];

type BrugerRaekke = {
  id: string;
  navn: string | null;
  email: string;
  telefon: string | null;
  avatar_url: string | null;
  rating: number | null;
  rolle: string | null;
  oprettet: string;
  suspenderet: boolean;
  suspenderet_til: string | null;
  konto_lukket_kl: string | null;
  advarsler_antal: number;
  paamindelser_antal: number;
};

export default async function AdminBrugere({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; filter?: string }>;
}) {
  const { q, filter: filterParam } = await searchParams;
  const filter: FilterId = FILTRE.some((f) => f.id === filterParam) ? (filterParam as FilterId) : "";
  const soeg = (q ?? "").trim().slice(0, 200);

  // Rollen tjekkes paa selve siden (ikke kun i layoutet), foer service-role bruges.
  const { admin: supabase } = await assertRole("medarbejder");

  const { data, error } = await supabase.rpc("admin_brugere_soeg", {
    p_q: soeg || null,
    p_filter: filter || null,
    p_graense: 50,
  });
  if (error) console.error("admin_brugere_soeg fejlede:", error);
  const users = (data ?? []) as BrugerRaekke[];

  const stjerner = (rating: number | null) => {
    const n = Math.round(rating ?? 0);
    return (
      <span className="text-amber-400 text-sm">
        {"★".repeat(n)}
        <span className="text-neutral-300">{"★".repeat(5 - n)}</span>
      </span>
    );
  };

  const filterHref = (id: string) => {
    const p = new URLSearchParams();
    if (soeg) p.set("q", soeg);
    if (id) p.set("filter", id);
    return `/admin/brugere${p.size ? `?${p}` : ""}`;
  };

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-4xl mx-auto">
      <AdminSideHoved
        titel="Brugere"
        forklaring="Find en bruger og se profil, advarsler, auktioner, bud og bedømmelser. Herfra kan du også advare eller suspendere."
      />

      <BrugereFaner aktiv="soeg" />

      <Suspense>
        <BrugerSearch />
      </Suspense>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrér brugere">
        {FILTRE.map((f) => (
          <Link
            key={f.id || "alle"}
            href={filterHref(f.id)}
            aria-current={filter === f.id ? "true" : undefined}
            className={`inline-flex min-h-9 items-center rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
              filter === f.id
                ? "border-neutral-900 bg-neutral-900 text-white"
                : "border-neutral-200 bg-white text-neutral-600 hover:border-neutral-300 hover:text-neutral-900"
            }`}
          >
            {f.label}
          </Link>
        ))}
      </div>

      {error && (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">
          Brugerne kunne ikke hentes. Prøv igen om lidt.
        </p>
      )}

      <div className="space-y-2">
        {users.map((user) => (
          <Link
            key={user.id}
            href={`/admin/brugere/${user.id}`}
            className="flex flex-wrap items-center gap-3 sm:gap-4 rounded-xl border border-neutral-200 bg-white p-4 transition-shadow hover:shadow-md"
          >
            <Avatar url={user.avatar_url} navn={user.navn} size={48} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-neutral-900">{user.navn ?? "Uden navn"}</p>
              <p className="truncate text-sm text-neutral-500">
                {user.email}
                {user.telefon ? ` · ${user.telefon}` : ""}
              </p>
            </div>
            <div className="hidden sm:block">{stjerner(user.rating)}</div>
            <div className="flex flex-wrap items-center gap-1.5">
              {user.rolle && user.rolle !== "bruger" && <RolleBadge rolle={user.rolle} />}
              {user.konto_lukket_kl ? (
                <span className="rounded-full bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white">
                  Lukket
                </span>
              ) : (
                <StatusBadge status={brugerStatus(user, user.advarsler_antal)} />
              )}
              {user.advarsler_antal > 0 && (
                <span className="rounded-full bg-yellow-50 px-2 py-0.5 text-xs font-medium text-yellow-800">
                  {user.advarsler_antal} {user.advarsler_antal === 1 ? "advarsel" : "advarsler"}
                </span>
              )}
              {user.paamindelser_antal > 0 && (
                <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600">
                  {user.paamindelser_antal} {user.paamindelser_antal === 1 ? "påmindelse" : "påmindelser"}
                </span>
              )}
            </div>
            <svg className="hidden h-5 w-5 shrink-0 text-neutral-300 sm:block" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        ))}
        {!error && users.length === 0 && (
          <div className="rounded-xl border border-neutral-200 bg-white p-10 text-center text-neutral-400">
            Ingen brugere fundet – prøv et andet navn, e-mail, telefonnummer eller bruger-id.
          </div>
        )}
        {users.length === 50 && (
          <p className="text-center text-xs text-neutral-400">
            Viser de 50 nyeste. Søg mere præcist for at finde andre.
          </p>
        )}
      </div>
    </div>
  );
}
