import AuctionCard, { type DummyAuction } from "@/components/AuctionCard";

export default function FeaturedCarousel({
  auktioner,
}: {
  auktioner: DummyAuction[];
}) {
  if (auktioner.length === 0) return null;

  // Listen duplikeres, så translateX(-50%) altid lander præcis hvor det
  // oprindelige (ikke-klonede) sæt kort sluttede – det giver det sømløse loop.
  const items = [...auktioner, ...auktioner];

  return (
    <div className="w-full overflow-hidden">
      <div className="flex w-max animate-[scroll-karussel_45s_linear_infinite] gap-4 hover:[animation-play-state:paused]">
        {items.map((auktion, i) => (
          <div key={`${auktion.id}-${i}`} className="w-72 shrink-0">
            <AuctionCard auktion={auktion} />
          </div>
        ))}
      </div>
    </div>
  );
}
