import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { anonymUsername } from "@/lib/anonymUsername";
import { mapAuctionTilKort } from "@/lib/mapAuctionCard";
import AuctionCard from "@/components/AuctionCard";
import AvatarUpload from "@/components/profile/AvatarUpload";
import ProfileTabs, { type MitBud } from "@/components/profile/ProfileTabs";
import StarRating from "@/components/profile/StarRating";

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

  if (erEgenProfil) {
    const [
      { data: egneAuktionerRaw },
      { data: mineBidsRaw },
      { data: egenEmail },
      { data: egneRatings },
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
      supabase.from("ratings").select("stjerner").eq("til_bruger_id", id),
    ]);

    const antalEgneRatings = egneRatings?.length ?? 0;
    const gennemsnitEgneRatings =
      antalEgneRatings > 0
        ? (egneRatings ?? []).reduce((sum, r) => sum + r.stjerner, 0) /
          antalEgneRatings
        : 0;

    const egneAuktioner = (egneAuktionerRaw ?? []).map(mapAuctionTilKort);

    // Find unikke auktion-id'er brugeren har budt på, og deres højeste eget bud.
    const egneBudPerAuktion = new Map<string, number>();
    for (const bud of mineBidsRaw ?? []) {
      const nuværende = egneBudPerAuktion.get(bud.auktion_id) ?? 0;
      if (bud.beløb > nuværende) {
        egneBudPerAuktion.set(bud.auktion_id, bud.beløb);
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

      // Find den førende budgiver pr. auktion (kun relevant for afsluttede auktioner).
      const førendePerAuktion = new Map<string, { bruger_id: string; beløb: number }>();
      for (const bud of alleBudPåDisse ?? []) {
        const nuværende = førendePerAuktion.get(bud.auktion_id);
        if (!nuværende || bud.beløb > nuværende.beløb) {
          førendePerAuktion.set(bud.auktion_id, bud);
        }
      }

      mineBud = (relevanteAuktioner ?? []).map((auktion) => {
        const erSlut = new Date(auktion.slutter_kl) <= new Date();
        const førende = førendePerAuktion.get(auktion.id);
        const status = !erSlut
          ? "aktiv"
          : førende?.bruger_id === id
            ? "vinder"
            : "overbud";

        return {
          auktionId: auktion.id,
          titel: auktion.titel,
          billede: auktion.billeder?.[0] ?? null,
          egetBud: egneBudPerAuktion.get(auktion.id) ?? 0,
          status,
        };
      });
    }

    return (
      <main className="flex-1 bg-white px-4 py-8 sm:px-8">
        <div className="mx-auto max-w-5xl">
          <div className="flex flex-wrap items-center gap-4">
            <AvatarUpload brugerId={id} avatarUrl={profil.avatar_url} />

            <div>
              <h1 className="text-xl font-bold text-neutral-900">
                {profil.navn}
              </h1>
              <p className="text-sm text-neutral-500">
                Medlem siden {medlemSiden}
              </p>
              <div className="mt-1">
                <StarRating
                  gennemsnit={gennemsnitEgneRatings}
                  antal={antalEgneRatings}
                />
              </div>
            </div>

            <Link
              href={`/profil/${id}?fane=indstillinger`}
              className="ml-auto rounded-lg border border-brand px-4 py-2 text-sm font-medium text-brand hover:bg-brand hover:text-white"
            >
              Rediger profil
            </Link>
          </div>

          <div className="mt-8">
            <Suspense>
              <ProfileTabs
                egneAuktioner={egneAuktioner}
                mineBud={mineBud}
                brugerId={id}
                navn={profil.navn}
                telefon={egenEmail?.telefon ?? null}
                email={egenEmail?.email ?? ""}
                avatarUrl={profil.avatar_url}
              />
            </Suspense>
          </div>
        </div>
      </main>
    );
  }

  // Offentlig profil
  const [{ data: aktiveAuktionerRaw }, { data: ratings }] = await Promise.all([
    supabase
      .from("auctions")
      .select("*, bids(count)")
      .eq("bruger_id", id)
      .eq("status", "aktiv")
      .gt("slutter_kl", new Date().toISOString())
      .order("oprettet", { ascending: false }),
    supabase
      .from("ratings")
      .select("*")
      .eq("til_bruger_id", id)
      .order("oprettet", { ascending: false }),
  ]);

  const aktiveAuktioner = (aktiveAuktionerRaw ?? []).map(mapAuctionTilKort);

  const antalRatings = ratings?.length ?? 0;
  const gennemsnitRating =
    antalRatings > 0
      ? (ratings ?? []).reduce((sum, r) => sum + r.stjerner, 0) / antalRatings
      : 0;

  return (
    <main className="flex-1 bg-white px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-5xl">
        <div className="flex flex-wrap items-center gap-4">
          <div className="h-24 w-24 overflow-hidden rounded-full border border-neutral-200 bg-neutral-100">
            {profil.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={profil.avatar_url}
                alt={profil.navn}
                className="h-full w-full object-cover"
              />
            ) : (
              <svg
                viewBox="0 0 24 24"
                className="h-full w-full p-5 text-neutral-400"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"
                />
              </svg>
            )}
          </div>

          <div>
            <h1 className="text-xl font-bold text-neutral-900">
              {profil.navn}
            </h1>
            <p className="text-sm text-neutral-500">
              Medlem siden {medlemSiden}
            </p>
            <div className="mt-1">
              <StarRating gennemsnit={gennemsnitRating} antal={antalRatings} />
            </div>
          </div>
        </div>

        <div className="mt-8 border-t border-neutral-200 pt-6">
          <h2 className="text-sm font-semibold text-neutral-900">
            Aktive auktioner
          </h2>
          {aktiveAuktioner.length === 0 ? (
            <p className="mt-2 text-sm text-neutral-500">
              Ingen aktive auktioner lige nu.
            </p>
          ) : (
            <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
              {aktiveAuktioner.map((auktion) => (
                <AuctionCard key={auktion.id} auktion={auktion} />
              ))}
            </div>
          )}
        </div>

        <div className="mt-8 border-t border-neutral-200 pt-6">
          <h2 className="text-sm font-semibold text-neutral-900">
            Bedømmelser
          </h2>
          {!ratings || ratings.length === 0 ? (
            <p className="mt-2 text-sm text-neutral-500">
              Ingen bedømmelser endnu.
            </p>
          ) : (
            <ul className="mt-3 space-y-4">
              {ratings.map((rating) => (
                <li key={rating.id} className="border-b border-neutral-100 pb-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-neutral-900">
                      {anonymUsername(rating.fra_bruger_id)}
                    </span>
                    <span className="text-xs text-neutral-400">
                      {new Date(rating.oprettet).toLocaleDateString("da-DK", {
                        dateStyle: "medium",
                      })}
                    </span>
                  </div>
                  <div className="mt-1 flex">
                    {[1, 2, 3, 4, 5].map((i) => (
                      <svg
                        key={i}
                        viewBox="0 0 24 24"
                        className={`h-3.5 w-3.5 ${
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
                    <p className="mt-1 text-sm text-neutral-700">
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
