"use client";

import { useEffect, useRef, useState } from "react";
import AuctionCard, { type DummyAuction } from "@/components/AuctionCard";

// Skal matche klasserne nedenfor: w-[220px] og gap-4 (16px).
const KORT_BREDDE = 220;
const MELLEMRUM = 16;

export default function FeaturedCarousel({
  auktioner,
}: {
  auktioner: DummyAuction[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [skalRulle, setSkalRulle] = useState(false);

  // Kortene skal kun rulle, hvis de faktisk fylder mere end den synlige
  // bredde. Ellers ville klonen nedenfor stå side om side med originalen og
  // vise de samme auktioner to gange.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const opdater = () => {
      const naturligBredde =
        auktioner.length * KORT_BREDDE +
        Math.max(auktioner.length - 1, 0) * MELLEMRUM;
      setSkalRulle(naturligBredde > container.clientWidth);
    };

    opdater();
    const observer = new ResizeObserver(opdater);
    observer.observe(container);
    return () => observer.disconnect();
  }, [auktioner.length]);

  if (auktioner.length === 0) return null;

  // Listen duplikeres, så translateX(-50%) altid lander præcis hvor det
  // oprindelige (ikke-klonede) sæt kort sluttede - det giver det sømløse loop.
  const items = skalRulle ? [...auktioner, ...auktioner] : auktioner;

  return (
    <div ref={containerRef} className="w-full overflow-hidden">
      <div
        className={`flex w-max gap-4 ${
          skalRulle
            ? "animate-[scroll-karussel_25s_linear_infinite] hover:[animation-play-state:paused]"
            : ""
        }`}
      >
        {items.map((auktion, i) => (
          <div key={`${auktion.id}-${i}`} className="w-[220px] shrink-0">
            <AuctionCard auktion={auktion} />
          </div>
        ))}
      </div>
    </div>
  );
}
