"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

// Handlen oprettes af pg_cron op til et minut efter auktionen er slut, så i
// det vindue findes den endnu ikke, når siden renderes. I stedet for at vise
// en boks uden vej videre, poller vi til handlen dukker op.
//
// Almindelig bruger-klient: RLS lader køber og sælger læse deres egen handel.
const INTERVAL_MS = 5000;
const MAKS_FORSOEG = 24; // ~2 minutter

export default function StartChatKnap({
  auktionId,
  tradeId,
}: {
  auktionId: string;
  tradeId: string | null;
}) {
  const [id, setId] = useState<string | null>(tradeId);
  const [opgivet, setOpgivet] = useState(false);

  useEffect(() => {
    if (id) return;

    let afbrudt = false;
    let forsoeg = 0;

    async function tjek() {
      const supabase = createClient();
      const { data } = await supabase
        .from("trades")
        .select("id")
        .eq("auction_id", auktionId)
        .maybeSingle();

      if (afbrudt) return;

      if (data?.id) {
        setId(data.id as string);
        return;
      }

      forsoeg += 1;
      if (forsoeg >= MAKS_FORSOEG) {
        // Vi holder op med at spørge frem for at banke løs på databasen i
        // det uendelige, hvis noget er gået galt i afregningen.
        setOpgivet(true);
        return;
      }

      timer = setTimeout(tjek, INTERVAL_MS);
    }

    let timer = setTimeout(tjek, INTERVAL_MS);
    // Spørg også med det samme - handlen kan være oprettet i sekundet
    // mellem server-renderingen og at siden nåede frem.
    tjek();

    return () => {
      afbrudt = true;
      clearTimeout(timer);
    };
  }, [auktionId, id]);

  if (id) {
    return (
      <Link
        href={`/mine-handler/${id}`}
        className="mt-3 inline-flex items-center gap-2 rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-orange-mork"
      >
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M21 11.5a8.38 8.38 0 0 1-9 8.4 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5a8.5 8.5 0 0 1 17 0z"
          />
        </svg>
        Start chat
      </Link>
    );
  }

  if (opgivet) {
    return (
      <p className="mt-3 text-sm text-neutral-600">
        Handlen er ikke oprettet endnu. Prøv at genindlæse siden om lidt — eller
        find den under{" "}
        <Link href="/mine-handler" className="font-medium text-brand underline">
          Mine handler
        </Link>
        .
      </p>
    );
  }

  return (
    <button
      type="button"
      disabled
      aria-busy="true"
      className="mt-3 inline-flex cursor-wait items-center gap-2 rounded-lg bg-neutral-300 px-5 py-2.5 text-sm font-semibold text-neutral-600"
    >
      <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z"
        />
      </svg>
      Handlen oprettes…
    </button>
  );
}
