"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Henter siden igen fra serveren hvert minut, mens fanen er synlig, og når
// man vender tilbage til fanen - så tal og budstatus holder sig friske.
export default function LiveOpdatering({ sekunder = 60 }: { sekunder?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, sekunder * 1000);
    function vedSynlig() {
      if (document.visibilityState === "visible") router.refresh();
    }
    document.addEventListener("visibilitychange", vedSynlig);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", vedSynlig);
    };
  }, [router, sekunder]);
  return null;
}
