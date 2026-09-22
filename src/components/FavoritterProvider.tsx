"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Favoritterne hentes EEN gang og deles af alle auktionskort på siden.
// Alternativet - at hvert kort selv slår op - ville give ét kald pr. kort på
// en side med 50 auktioner.

type FavoritContext = {
  erFavorit: (auktionId: string) => boolean;
  toggle: (auktionId: string) => void;
  klar: boolean;
};

const Ctx = createContext<FavoritContext | null>(null);

export function useFavoritter() {
  const ctx = useContext(Ctx);
  if (!ctx) {
    // Et kort uden provider skal ikke vælte siden - det viser bare et tomt
    // hjerte, der sender til login.
    return null;
  }
  return ctx;
}

export default function FavoritterProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [ider, setIder] = useState<Set<string>>(new Set());
  const [bruger, setBruger] = useState<string | null>(null);
  const [klar, setKlar] = useState(false);

  useEffect(() => {
    let afbrudt = false;

    async function hent() {
      const supabase = createClient();
      const { data: auth } = await supabase.auth.getUser();

      if (afbrudt) return;

      if (!auth.user) {
        setBruger(null);
        setKlar(true);
        return;
      }

      setBruger(auth.user.id);

      // RLS filtrerer selv til brugerens egne rækker.
      const { data } = await supabase.from("favorites").select("auction_id");

      if (afbrudt) return;

      setIder(new Set((data ?? []).map((r) => r.auction_id as string)));
      setKlar(true);
    }

    hent();
    return () => {
      afbrudt = true;
    };
  }, []);

  const erFavorit = useCallback(
    (auktionId: string) => ider.has(auktionId),
    [ider],
  );

  const toggle = useCallback(
    (auktionId: string) => {
      if (!bruger) {
        // Ikke logget ind: send til login og tilbage hertil bagefter.
        router.push(`/login?redirect=${encodeURIComponent(pathname)}`);
        return;
      }

      const varFavorit = ider.has(auktionId);

      // Optimistisk opdatering: hjertet skifter med det samme. Fejler
      // skrivningen, rulles det tilbage nedenfor.
      setIder((forrige) => {
        const ny = new Set(forrige);
        if (varFavorit) ny.delete(auktionId);
        else ny.add(auktionId);
        return ny;
      });

      const supabase = createClient();

      const skriv = varFavorit
        ? supabase
            .from("favorites")
            .delete()
            .eq("user_id", bruger)
            .eq("auction_id", auktionId)
        : supabase
            .from("favorites")
            .insert({ user_id: bruger, auction_id: auktionId });

      skriv.then(({ error }) => {
        if (!error) return;

        // 23505 = allerede gemt. Så er ønsket tilstand allerede opnået, og
        // der er intet at rulle tilbage.
        if (error.code === "23505") return;

        console.error("Kunne ikke gemme favorit:", error);
        setIder((forrige) => {
          const ny = new Set(forrige);
          if (varFavorit) ny.add(auktionId);
          else ny.delete(auktionId);
          return ny;
        });
      });
    },
    [bruger, ider, pathname, router],
  );

  return (
    <Ctx.Provider value={{ erFavorit, toggle, klar }}>{children}</Ctx.Provider>
  );
}
