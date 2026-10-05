"use client";

import Link from "next/link";
import Ikon from "@/components/Ikon";
import { badgeTekst } from "@/lib/notifikationer/visning";
import { beskederTekst, useAntalUlaesteBeskeder } from "@/components/topbar/UlaesteBeskeder";

export default function BeskederLink({ className }: { className: string }) {
  const antal = useAntalUlaesteBeskeder();
  return (
    <Link
      href="/beskeder"
      aria-label={antal > 0 ? `Beskeder, ${beskederTekst(antal)}` : "Beskeder"}
      title="Beskeder"
      className={`relative ${className}`}
    >
      <Ikon navn="besked" />
      {antal > 0 && (
        <span
          aria-hidden="true"
          className="absolute top-1 right-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-fejl-fyldt px-1 text-[11px] leading-none font-semibold text-white ring-2 ring-white"
        >
          {badgeTekst(antal)}
        </span>
      )}
    </Link>
  );
}
