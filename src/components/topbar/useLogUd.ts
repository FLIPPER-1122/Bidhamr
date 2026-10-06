"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export const LOG_UD_FEJL = "Du kunne ikke logges ud. Tjek din forbindelse, og prøv igen.";

export function useLogUd(efter?: () => void) {
  const router = useRouter();
  const [loggerUd, setLoggerUd] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);

  async function logUd() {
    setLoggerUd(true);
    setFejl(null);
    let lykkedes = false;
    try {
      // Indlæses først ved klik, så Supabase-klienten ikke er med i topbarens
      // JavaScript på hver side.
      const { createClient } = await import("@/lib/supabase/client");
      const { error } = await createClient().auth.signOut();
      if (error) throw error;
      lykkedes = true;
    } catch (err) {
      console.error("Log ud fejlede:", err);
      setFejl(LOG_UD_FEJL);
    } finally {
      // Ved succes skifter siden; ellers skal knappen kunne bruges igen.
      if (!lykkedes) setLoggerUd(false);
    }
    if (!lykkedes) return;
    efter?.();
    router.push("/login");
    router.refresh();
  }

  return { logUd, loggerUd, fejl };
}
