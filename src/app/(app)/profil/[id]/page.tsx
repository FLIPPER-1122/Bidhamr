import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { kortNavn } from "@/lib/kortNavn";
import { mapAuctionTilKort } from "@/lib/mapAuctionCard";
import AuctionCard from "@/components/AuctionCard";
import ProfileHeader from "@/components/profile/ProfileHeader";
import ProfileTabs, {
  type MitBud,
  type EgenAuktion,
  type Rating,
} from "@/components/profile/ProfileTabs";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const [{ data: authData }, { data: profil }] = await Promise.all([
    supabase.auth.getUser(),
    supabase.from("users").select("navn").eq("id", id).single(),
  ]);
  if (!profil) return { title: "Profil" };
  const erEgen = authData.user?.id === id;
  const visNavn = erEgen ? (profil.navn ?? "") : kortNavn(profil.navn);
  return { title: `${visNavn}s profil – BidHamr` };
}

export default async function ProfilPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: authData }, { data: profil }] = await Promise.all([
    supabase.auth.getUser(),
    supabase
      .from("users")
      .select("id, navn, avatar_url, oprettet")
      .eq("id", id)
      .single(),
  ]);

  if (!profil) {
    notFound();
  }

  const erEgenProfil = authData.user?.id === id;

  const medlemSiden = new Date(profil.oprettet).toLocaleDateString("da-DK", {
    month: "long",
    year: "numeric",
  });

  // ── Egen profil ────────────────────────────────────────────────────────────
  if (erEgenProfil) {
    const [
      { data: egneAuktionerRaw },
      { data: mineBidsRaw },
      { data: egenEmail },
      { data: egneRatings },
      { data: gennemforteHandlerRaw },
    ] = await Promise.all([
      supabase
        .from("auctions")
        .select("*, bids(count)")
        .eq("bruger_id", id)
        .order("oprettet", { ascending: false }),
      supabase
        .from("bids")
        .select("*")
        .eq("bruger_id", id)
        .order("oprettet", { ascending: false }),
      supabase.from("users").select("email, telefon").eq("id", id).single(),
      supabase
        .from("ratings")
        .select("id, fra_bruger_id, stjerner, kommentar, oprettet")
        .eq("til_bruger_id", id)
        .eq("skjult", false)
        .order("oprettet", { ascending: false }),
      supabase
        .from("transactions")
        .select("id")
        .or(`køber_id.eq.${id},sælger_id.eq.${id}`)
        .eq("status", "frigivet"),
    ]);

    const antalRatings = egneRatings?.length ?? 0;
    const gennemsnitRating =
      antalRatings > 0
        ? (egneRatings ?? []).reduce((sum, r) => sum + r.stjerner, 0) /
          antalRatings
        : 0;

    // Byg egne auktioner med slutter_kl til status-badge
    const egneAuktioner: EgenAuktion[] = (egneAuktionerRaw ?? []).map(
      (auktion) => ({
        ...mapAuctionTilKort(auktion),
        slutterKl: auktion.slutter_kl,
      }),
    );

    // Find unikke auktions-id'er brugeren har budt på og højeste eget bud
    const egneBudPerAuktion = new Map<string, number>();
    for (const bud of mineBidsRaw ?? []) {
      const nuværende = egneBudPerAuktion.get(bud.auktion_id) ?? 0;
      if (bud.beløb > nuværende) {
        egneBudPerAuktion.set(bud.auktion_id, Number(bud.beløb));
      }
    }
    const budAuktionIds = Array.from(egneBudPerAuktion.keys());

    let mineBud: MitBud[] = [];

    if (budAuktionIds.length > 0) {
      const [{ data: relevanteAuktioner }, { data: alleBudPåDisse }] =
        await Promise.all([
          supabase
            .from("auctions")
            .select("id, titel, billeder, slutter_kl")
            .in("id", budAuktionIds),
          supabase
            .from("bids")
            .select("*")
            .in("auktion_id", budAuktionIds),
        ]);

      const førendePerAuktion = new Map<
        string,
        { bruger_id: string; beløb: number }
      >();
      for (const bud of alleBudPåDisse ?? []) {
        const nuværende = førendePerAuktion.get(bud.auktion_id);
        if (!nuværende || bud.beløb > nuværende.beløb) {
          førendePerAuktion.set(bud.auktion_id, bud);
        }
      }

      mineBud = (relevanteAuktioner ?? []).map((auktion) => {
        const erSlut = new Date(auktion.slutter_kl) <= new Date();
        const førende = førendePerAuktion.get(auktion.id);
        const status: MitBud["status"] = !erSlut
          ? "aktiv"
          : førende?.bruger_id === id
            ? "vinder"
            : "overbud";

        const højesteBud = Number(førende?.beløb ?? 0);

        return {
          auktionId: auktion.id,
          titel: auktion.titel,
          billede: auktion.billeder?.[0] ?? null,
          egetBud: egneBudPerAuktion.get(auktion.id) ?? 0,
          højesteBud,
          status,
        };
      });
    }

    const egenFraIds = [...new Set((egneRatings ?? []).map((r) => r.fra_bruger_id))];
    const { data: egenFraNavne } = egenFraIds.length > 0
      ? await supabase.from("users").select("id, navn").in("id", egenFraIds)
      : { data: [] };
    const egenNavnMap = Object.fromEntries((egenFraNavne ?? []).map((u) => [u.id, u.navn as string | null]));

    const ratings: Rating[] = (egneRatings ?? []).map((r) => ({
      ...r,
      fra_bruger_navn: kortNavn(egenNavnMap[r.fra_bruger_id]),
    }));

    return (
      <main className="flex-1 bg-neutral-50 px-4 py-8 sm:px-8">
        <div className="mx-auto max-w-5xl">
          <ProfileHeader
            navn={profil.navn ?? ""}
            email={egenEmail?.email}
            avatarUrl={profil.avatar_url}
            medlemSiden={medlemSiden}
            gennemsnitRating={gennemsnitRating}
            antalRatings={antalRatings}
            stats={{
              auktionerOprettet: egneAuktioner.length,
              budAfgivet: budAuktionIds.length,
              gennemforteHandler: gennemforteHandlerRaw?.length ?? 0,
            }}
            erEgenProfil={true}
            brugerId={id}
          />

          <Suspense>
            <ProfileTabs
              egneAuktioner={egneAuktioner}
              mineBud={mineBud}
              ratings={ratings}
              brugerId={id}
              navn={profil.navn}
              telefon={egenEmail?.telefon ?? null}
              email={egenEmail?.email ?? ""}
              avatarUrl={profil.avatar_url}
            />
          </Suspense>
        </div>
      </main>
    );
  }

  // ── Offentlig profil ───────────────────────────────────────────────────────
  const [{ data: aktiveAuktionerRaw }, { data: ratingsRaw }] = await Promise.all([
    supabase
      .from("auctions")
      .select("*, bids(count)")
      .eq("bruger_id", id)
      .eq("status", "aktiv")
      .gt("slutter_kl", new Date().toISOString())
      .order("oprettet", { ascending: false }),
    supabase
      .from("ratings")
      .select("id, fra_bruger_id, stjerner, kommentar, oprettet")
      .eq("til_bruger_id", id)
      .eq("skjult", false)
      .order("oprettet", { ascending: false }),
  ]);

  const aktiveAuktioner = (aktiveAuktionerRaw ?? []).map(mapAuctionTilKort);

  const fraIds = [...new Set((ratingsRaw ?? []).map((r) => r.fra_bruger_id))];
  const { data: fraNavne } = fraIds.length > 0
    ? await supabase.from("users").select("id, navn").in("id", fraIds)
    : { data: [] };
  const fraNavnMap = Object.fromEntries((fraNavne ?? []).map((u) => [u.id, u.navn as string | null]));

  const ratings = (ratingsRaw ?? []).map((r) => ({
    ...r,
    fra_bruger_navn: kortNavn(fraNavnMap[r.fra_bruger_id]),
  }));

  const antalRatings = ratings?.length ?? 0;
  const gennemsnitRating =
    antalRatings > 0
      ? (ratings ?? []).reduce((sum, r) => sum + r.stjerner, 0) / antalRatings
      : 0;

  return (
    <main className="flex-1 bg-neutral-50 px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <ProfileHeader
          navn={kortNavn(profil.navn)}
          avatarUrl={profil.avatar_url}
          medlemSiden={medlemSiden}
          gennemsnitRating={gennemsnitRating}
          antalRatings={antalRatings}
          stats={{
            auktionerOprettet: aktiveAuktioner.length,
            budAfgivet: 0,
            gennemforteHandler: 0,
          }}
          erEgenProfil={false}
          brugerId={id}
        />

        {/* Aktive auktioner */}
        <div className="rounded-xl border border-neutral-200 bg-white p-6">
          <h2 className="text-sm font-semibold text-neutral-900">
            Aktive auktioner
          </h2>
          {aktiveAuktioner.length === 0 ? (
            <p className="mt-3 text-sm text-neutral-500">
              Ingen aktive auktioner lige nu.
            </p>
          ) : (
            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
              {aktiveAuktioner.map((auktion) => (
                <AuctionCard key={auktion.id} auktion={auktion} />
              ))}
            </div>
          )}
        </div>

        {/* Bedømmelser */}
        <div className="rounded-xl border border-neutral-200 bg-white p-6">
          <h2 className="text-sm font-semibold text-neutral-900">
            Bedømmelser
          </h2>
          {!ratings || ratings.length === 0 ? (
            <p className="mt-3 text-sm text-neutral-500">
              Ingen bedømmelser endnu.
            </p>
          ) : (
            <ul className="mt-4 space-y-3">
              {ratings.map((rating) => (
                <li
                  key={rating.id}
                  className="rounded-xl border border-neutral-100 bg-neutral-50 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <Link
                      href={`/profil/${rating.fra_bruger_id}`}
                      className="text-sm font-medium text-neutral-900 hover:text-brand hover:underline"
                    >
                      {rating.fra_bruger_navn}
                    </Link>
                    <span className="shrink-0 text-xs text-neutral-400">
                      {new Date(rating.oprettet).toLocaleDateString("da-DK", {
                        dateStyle: "medium",
                      })}
                    </span>
                  </div>
                  <div className="mt-1.5 flex gap-0.5">
                    {[1, 2, 3, 4, 5].map((i) => (
                      <svg
                        key={i}
                        viewBox="0 0 24 24"
                        className={`h-4 w-4 ${
                          i <= rating.stjerner
                            ? "fill-brand text-brand"
                            : "fill-neutral-200 text-neutral-200"
                        }`}
                      >
                        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                      </svg>
                    ))}
                  </div>
                  {rating.kommentar && (
                    <p className="mt-2 text-sm text-neutral-600">
                      {rating.kommentar}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </main>
  );
}
