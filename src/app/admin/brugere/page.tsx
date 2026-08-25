import Link from "next/link";
import { Suspense } from "react";
import { createAdminClient } from "@/lib/supabase/admin";
import Avatar from "@/components/Avatar";
import BrugerSearch from "@/components/admin/BrugerSearch";
import { StatusBadge, brugerStatus, RolleBadge } from "@/components/admin/StatusBadge";

export default async function AdminBrugere({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const supabase = createAdminClient();

  let query = supabase
    .from("users")
    .select("id, navn, email, telefon, rating, rolle, oprettet, avatar_url, suspenderet, suspenderet_til")
    .order("oprettet", { ascending: false })
    .limit(50);

  if (q) {
    query = query.or(`navn.ilike.%${q}%,email.ilike.%${q}%,telefon.ilike.%${q}%`);
  }

  const { data: users } = await query;

  // Advarsel-antal for de viste brugere i ét opslag
  const userIds = (users ?? []).map((u) => u.id);
  const { data: advarsler } = userIds.length
    ? await supabase.from("advarsler").select("bruger_id").in("bruger_id", userIds)
    : { data: [] };
  const advarselCount: Record<string, number> = {};
  (advarsler ?? []).forEach((a) => {
    advarselCount[a.bruger_id] = (advarselCount[a.bruger_id] ?? 0) + 1;
  });

  const stjerner = (rating: number | null) => {
    const n = Math.round(rating ?? 0);
    return (
      <span className="text-amber-400 text-sm">
        {"★".repeat(n)}
        <span className="text-neutral-300">{"★".repeat(5 - n)}</span>
      </span>
    );
  };

  return (
    <div className="p-6 space-y-5 max-w-4xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900">Søg bruger</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Find en bruger og se deres profil, auktioner, bud og anmeldelser.
        </p>
      </div>

      <Suspense>
        <BrugerSearch />
      </Suspense>

      <div className="space-y-2">
        {(users ?? []).map((user) => (
          <Link
            key={user.id}
            href={`/admin/brugere/${user.id}`}
            className="flex items-center gap-4 rounded-xl border border-neutral-200 bg-white p-4 transition-shadow hover:shadow-md"
          >
            <Avatar url={user.avatar_url} navn={user.navn} size={48} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-neutral-900">
                {user.navn ?? "Uden navn"}
              </p>
              <p className="truncate text-sm text-neutral-500">
                {user.email}
                {user.telefon ? ` · ${user.telefon}` : ""}
              </p>
            </div>
            <div className="hidden sm:block">{stjerner(user.rating)}</div>
            {user.rolle && user.rolle !== "bruger" && (
              <RolleBadge rolle={user.rolle} />
            )}
            <StatusBadge
              status={brugerStatus(user, advarselCount[user.id] ?? 0)}
            />
            <svg className="h-5 w-5 shrink-0 text-neutral-300" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        ))}
        {(users ?? []).length === 0 && (
          <div className="rounded-xl border border-neutral-200 bg-white p-10 text-center text-neutral-400">
            Ingen brugere fundet — prøv et andet navn, e-mail eller telefonnummer.
          </div>
        )}
      </div>
    </div>
  );
}
