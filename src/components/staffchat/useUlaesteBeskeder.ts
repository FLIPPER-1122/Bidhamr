"use client";

// Antal ulæste beskeder fra BidHamr til menuens badge. Tallet kommer fra
// serveren ved første visning og hentes igen, når brugeren har været inde
// under /beskeder (der markeres samtaler som læst), når fanen bliver synlig,
// og hvert 60. sekund.
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { antalUlaesteStaffBeskeder } from "@/app/actions/staffChat";

const INTERVAL_MS = 60_000;

export function useUlaesteBeskeder(startAntal: number, aktiv: boolean) {
  const [antal, setAntal] = useState(startAntal);
  const pathname = usePathname();
  const foerste = useRef(true);

  const opdater = useCallback(async () => {
    const svar = await antalUlaesteStaffBeskeder();
    if ("antal" in svar) setAntal(svar.antal);
  }, []);

  useEffect(() => {
    if (foerste.current) {
      foerste.current = false;
      return;
    }
    if (!aktiv || !pathname.startsWith("/beskeder")) return;
    let aktuel = true;
    void antalUlaesteStaffBeskeder().then((svar) => {
      if (aktuel && "antal" in svar) setAntal(svar.antal);
    });
    return () => {
      aktuel = false;
    };
  }, [pathname, aktiv]);

  useEffect(() => {
    if (!aktiv) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void opdater();
    }, INTERVAL_MS);
    function vedSynlig() {
      if (document.visibilityState === "visible") void opdater();
    }
    document.addEventListener("visibilitychange", vedSynlig);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", vedSynlig);
    };
  }, [aktiv, opdater]);

  return antal;
}
