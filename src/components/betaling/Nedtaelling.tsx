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
  const [vis, setVis] = useState<string | null>(null);
  useEffect(() => {
    const opdater = () => setVis(tekst(til));
    opdater();
    const id = setInterval(opdater, 1000);
    return () => clearInterval(id);
  }, [til]);
  return <span className="tabular-nums">{vis ?? " "}</span>;
}
