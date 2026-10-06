"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function useLogUd(efter?: () => void) {
  const router = useRouter();
  const [loggerUd, setLoggerUd] = useState(false);

  async function logUd() {
    setLoggerUd(true);
    // Indlæses først ved klik, så Supabase-klienten ikke er med i topbarens
    // JavaScript på hver side.
    const { createClient } = await import("@/lib/supabase/client");
    await createClient().auth.signOut();
    efter?.();
    router.push("/login");
    router.refresh();
  }

  return { logUd, loggerUd };
}
