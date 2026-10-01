"use client";

import { FejlSide } from "@/components/betaling/SideTilstande";

export default function Fejl({ retry }: { error: Error; retry: () => void }) {
  return <FejlSide retry={retry} />;
}
