"use client";

import { useEffect, useRef } from "react";

// Ruller den aktive fane ind i synsfeltet, når fanerne er bredere end skærmen
// (mobil). Kun fanebjælken rulles - ikke selve siden.
export default function RulAktivFane({ aktiv: aktivId }: { aktiv: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const nav = ref.current?.parentElement;
    const aktiv = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !aktiv || nav.scrollWidth <= nav.clientWidth) return;
    const a = aktiv.getBoundingClientRect();
    const n = nav.getBoundingClientRect();
    nav.scrollLeft = Math.max(0, a.left - n.left + nav.scrollLeft - (nav.clientWidth - a.width) / 2);
  }, [aktivId]);
  return <span ref={ref} hidden />;
}
