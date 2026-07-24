"use client";

import { useState, useTransition } from "react";
import { submitRating } from "@/app/actions/submitRating";
import { anonymUsername } from "@/lib/anonymUsername";

export default function RatingForm({
  auktionId,
  tilBrugerId,
  rolle, // "køber" | "sælger" — hvem der bedømmes
}: {
  auktionId: string;
  tilBrugerId: string;
  rolle: "køber" | "sælger";
}) {
  const [valgtStjerner, setValgtStjerner] = useState(0);
  const [hoveredStjerner, setHoveredStjerner] = useState(0);
  const [afgivet, setAfgivet] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (afgivet) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
        <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
        Din bedømmelse er afgivet – tak!
      </div>
    );
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!valgtStjerner) {
      setFejl("Vælg venligst antal stjerner.");
      return;
    }
    setFejl(null);
    const formData = new FormData(e.currentTarget);
    formData.set("stjerner", String(valgtStjerner));
    startTransition(async () => {
      const res = await submitRating(formData);
      if (res?.error) {
        setFejl(res.error);
      } else {
        setAfgivet(true);
      }
    });
  }

  const displayed = hoveredStjerner || valgtStjerner;

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-5">
      <h3 className="text-sm font-semibold text-neutral-900">
        Bedøm {rolle === "sælger" ? "sælgeren" : "køberen"}{" "}
        <span className="font-normal text-neutral-500">
          ({anonymUsername(tilBrugerId)})
        </span>
      </h3>

      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
        <input type="hidden" name="auktion_id" value={auktionId} />
        <input type="hidden" name="til_bruger_id" value={tilBrugerId} />

        {/* Stjerne-selector */}
        <div>
          <p className="mb-2 text-xs text-neutral-500">Din vurdering</p>
          <div
            className="flex gap-1"
            onMouseLeave={() => setHoveredStjerner(0)}
          >
            {[1, 2, 3, 4, 5].map((i) => (
              <button
                key={i}
                type="button"
                onClick={() => setValgtStjerner(i)}
                onMouseEnter={() => setHoveredStjerner(i)}
                className="transition-transform hover:scale-110 focus:outline-none"
                aria-label={`${i} stjerner`}
              >
                <svg
                  viewBox="0 0 24 24"
                  className={`h-8 w-8 transition-colors ${
                    i <= displayed
                      ? "fill-brand text-brand"
                      : "fill-neutral-200 text-neutral-200"
                  }`}
                >
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
              </button>
            ))}
          </div>
          {valgtStjerner > 0 && (
            <p className="mt-1 text-xs text-neutral-500">
              {["", "Meget dårlig", "Dårlig", "OK", "God", "Fremragende"][valgtStjerner]}
            </p>
          )}
        </div>

        {/* Kommentar */}
        <div>
          <label
            htmlFor="kommentar"
            className="block text-xs font-medium text-neutral-700"
          >
            Kommentar{" "}
            <span className="font-normal text-neutral-400">(valgfri)</span>
          </label>
          <textarea
            id="kommentar"
            name="kommentar"
            rows={3}
            placeholder="Beskriv din oplevelse…"
            className="mt-1.5 w-full resize-none rounded-lg border border-neutral-300 px-3 py-2.5 text-sm text-neutral-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand"
          />
        </div>

        {fejl && (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
            {fejl}
          </p>
        )}

        <button
          type="submit"
          disabled={isPending || valgtStjerner === 0}
          className="rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#d62b38] disabled:opacity-50"
        >
          {isPending ? "Gemmer…" : "Afgiv bedømmelse"}
        </button>
      </form>
    </div>
  );
}
