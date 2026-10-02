"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { MouseEvent } from "react";
import type { Notifikation } from "@/app/actions/notifikationer";
import { markerLaest } from "@/app/actions/notifikationer";
import {
  fuldTid,
  meldNotifikationerOpdateret,
  relativTid,
  sikkertLink,
} from "@/lib/notifikationer/visning";

type Props = {
  n: Notifikation;
  // Kaldes med det samme (optimistisk), når notifikationen markeres læst.
  vedLaest: (id: string) => void;
  // Kaldes før navigation, fx for at lukke klokke-panelet.
  vedNavigation?: () => void;
  kompakt?: boolean;
};

const ramme =
  "flex w-full gap-3 rounded-xl px-3 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-groen";

export default function NotifikationPunkt({ n, vedLaest, vedNavigation, kompakt }: Props) {
  const router = useRouter();
  const ulaest = !n.laest_kl;
  const link = sikkertLink(n.link);

  async function marker() {
    if (!ulaest) return;
    vedLaest(n.id);
    const svar = await markerLaest([n.id]);
    if ("ok" in svar) meldNotifikationerOpdateret();
  }

  async function vedKlik(e: MouseEvent<HTMLAnchorElement>) {
    // Ny fane / nyt vindue: lad browseren gøre det, men markér stadig som læst.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      void marker();
      return;
    }
    e.preventDefault();
    vedNavigation?.();
    await marker();
    if (link) router.push(link);
  }

  const indhold = (
    <>
      <span className="mt-1.5 flex w-2.5 shrink-0 justify-center" aria-hidden="true">
        {ulaest && <span className="h-2.5 w-2.5 rounded-full bg-orange" />}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={`block text-[15px] leading-snug text-tekst ${ulaest ? "font-semibold" : "font-medium"}`}
        >
          {ulaest && <span className="sr-only">Ulæst: </span>}
          {n.titel}
        </span>
        {n.tekst && (
          <span
            className={`mt-0.5 block text-sm leading-normal text-tekst-daempet ${kompakt ? "line-clamp-2" : ""}`}
          >
            {n.tekst}
          </span>
        )}
        <time
          dateTime={n.oprettet_kl}
          title={fuldTid(n.oprettet_kl)}
          suppressHydrationWarning
          className="mt-1 block text-xs text-tekst-svag"
        >
          {relativTid(n.oprettet_kl)}
        </time>
      </span>
    </>
  );

  const baggrund = ulaest ? "bg-groen-lys/60 hover:bg-groen-lys" : "hover:bg-[#F7F7F7]";

  if (link) {
    return (
      <Link href={link} prefetch={false} onClick={vedKlik} className={`${ramme} ${baggrund}`}>
        {indhold}
      </Link>
    );
  }

  // Uden link: en knap, der bare markerer som læst. Læst og uden link: ren tekst.
  if (!ulaest) {
    return <div className="flex w-full gap-3 rounded-xl px-3 py-3">{indhold}</div>;
  }
  return (
    <button type="button" onClick={() => void marker()} className={`${ramme} ${baggrund}`}>
      {indhold}
    </button>
  );
}
