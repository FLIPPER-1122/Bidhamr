"use client";

// "Vi bruger brugtmomsordningen" på Firmaoplysninger. Bestemmer kun, om
// momsen vises i oplysningerne til firmaets egen faktura på varen (Salg).
// Via /api/offentlig/firma-brugtmoms (firmakonti må før lancering ikke
// kalde server actions - se src/lib/supabase/middleware.ts).
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { kaldOffentligHandling } from "@/lib/offentligHandling";
import { E_FEJL, E_HJAELP } from "@/components/erhverv/stil";
import { BRUGTMOMS_TEKST } from "@/lib/erhverv/fakturaOplysninger";

export default function BrugtmomsValg({ brugtmoms }: { brugtmoms: boolean }) {
  const router = useRouter();
  const [vaerdi, setVaerdi] = useState(brugtmoms);
  const [besked, setBesked] = useState<{ tekst: string; fejl: boolean } | null>(null);
  const [sender, start] = useTransition();

  function skift(ny: boolean) {
    setBesked(null);
    setVaerdi(ny);
    start(async () => {
      const fd = new FormData();
      fd.set("brugtmoms", ny ? "ja" : "nej");
      const res = await kaldOffentligHandling<{ ok: true; brugtmoms: boolean }>("firma-brugtmoms", fd);
      if ("fejl" in res) {
        setVaerdi(!ny);
        setBesked({ tekst: res.fejl || BRUGTMOMS_TEKST.fejl, fejl: true });
        return;
      }
      setVaerdi(res.brugtmoms);
      setBesked({ tekst: BRUGTMOMS_TEKST.gemt, fejl: false });
      router.refresh();
    });
  }

  return (
    <div>
      <label className="flex min-h-14 cursor-pointer items-center gap-4">
        <input
          type="checkbox"
          checked={vaerdi}
          disabled={sender}
          onChange={(e) => skift(e.target.checked)}
          aria-describedby="brugtmoms-hjaelp"
          className="h-7 w-7 shrink-0 accent-groen"
        />
        <span className="text-[18px] font-semibold text-tekst">{BRUGTMOMS_TEKST.label}</span>
      </label>
      <p id="brugtmoms-hjaelp" className={E_HJAELP}>
        {BRUGTMOMS_TEKST.hjaelp}
      </p>
      <p aria-live="polite" className={besked?.fejl ? E_FEJL : "mt-2 text-[16px] font-semibold text-groen-mork"}>
        {besked?.tekst}
      </p>
    </div>
  );
}
