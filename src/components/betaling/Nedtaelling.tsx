"use client";

import { useEffect, useState } from "react";

function tekst(til: string) {
  const ms = new Date(til).getTime() - Date.now();
  if (ms <= 0) return "Fristen er udløbet";
  const t = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return t > 0 ? `${t} t ${m} min tilbage` : `${m} min ${s} sek tilbage`;
}

export default function Nedtaelling({ til }: { til: string }) {
  // Teksten regnes allerede på serveren, så linjen ikke vokser (og skubber
  // indholdet ned - CLS), når siden bliver interaktiv. Serverens og
  // browserens tekst kan være et sekund forskellige - derfor
  // suppressHydrationWarning; effekten retter den med det samme.
  const [vis, setVis] = useState(() => tekst(til));
  useEffect(() => {
    const opdater = () => setVis(tekst(til));
    opdater();
    const id = setInterval(opdater, 1000);
    return () => clearInterval(id);
  }, [til]);
  return (
    <span className="tabular-nums" suppressHydrationWarning>
      {vis}
    </span>
  );
}
