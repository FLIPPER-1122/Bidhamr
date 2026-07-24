import Link from "next/link";

interface ProfileHeaderProps {
  navn: string;
  email?: string;
  avatarUrl: string | null;
  medlemSiden: string;
  gennemsnitRating: number;
  antalRatings: number;
  stats: {
    auktionerOprettet: number;
    budAfgivet: number;
    gennemforteHandler: number;
  };
  erEgenProfil: boolean;
  brugerId: string;
}

export default function ProfileHeader({
  navn,
  email,
  avatarUrl,
  medlemSiden,
  gennemsnitRating,
  antalRatings,
  stats,
  erEgenProfil,
  brugerId,
}: ProfileHeaderProps) {
  return (
    <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
      <div className="px-5 pb-6 pt-6 sm:px-8">
        {/* Avatar + navn */}
        <div className="flex flex-wrap items-center gap-4">
          <div className="h-20 w-20 shrink-0 overflow-hidden rounded-full border border-neutral-200 bg-neutral-100 sm:h-24 sm:w-24">
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={avatarUrl}
                alt={navn}
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

          <div className="flex-1">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <h1 className="text-2xl font-bold text-neutral-900 sm:text-3xl">
                {navn}
              </h1>
              {erEgenProfil && (
                <Link
                  href={`/profil/${brugerId}?fane=indstillinger`}
                  className="rounded-lg border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 shadow-sm hover:border-brand hover:text-brand"
                >
                  Rediger profil
                </Link>
              )}
            </div>
            {email && (
              <p className="mt-0.5 text-sm text-neutral-400">{email}</p>
            )}

            <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm text-neutral-500">
              <span className="flex items-center gap-1.5">
                <svg
                  viewBox="0 0 24 24"
                  className="h-4 w-4 shrink-0"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <rect x="3" y="4" width="18" height="18" rx="2" />
                  <path strokeLinecap="round" d="M16 2v4M8 2v4M3 10h18" />
                </svg>
                Medlem siden {medlemSiden}
              </span>

              {antalRatings === 0 ? (
                <span className="text-neutral-400">Ingen bedømmelser endnu</span>
              ) : (
                <span>
                  ⭐ {gennemsnitRating.toFixed(1)} · {antalRatings}{" "}
                  bedømmelse{antalRatings === 1 ? "" : "r"}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Statistik-række */}
        <div className="mt-5 grid grid-cols-3 gap-3">
          {[
            { tal: stats.auktionerOprettet, label: "Auktioner oprettet" },
            { tal: stats.budAfgivet, label: "Bud afgivet" },
            { tal: stats.gennemforteHandler, label: "Gennemførte handler" },
          ].map(({ tal, label }) => (
            <div
              key={label}
              className="rounded-lg bg-neutral-50 px-3 py-3 text-center"
            >
              <p className="text-2xl font-bold text-neutral-900">{tal}</p>
              <p className="mt-0.5 text-xs text-neutral-500">{label}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
