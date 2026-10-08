"use client";

// "Log ud" i toppen af firma-dashboardet. Logger ud direkte mod Supabase i
// browseren (ingen server action - virker også før lancering).
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { FIRMA_DASHBOARD } from "@/lib/tekster/erhverv";

export default function FirmaLogUd() {
  const router = useRouter();
  const [loggerUd, setLoggerUd] = useState(false);

  async function logUd() {
    setLoggerUd(true);
    await createClient().auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={logUd}
      disabled={loggerUd}
      aria-busy={loggerUd || undefined}
      className="btn btn-sekundaer h-auto min-h-12 border-2 px-5 py-2 text-[17px]"
    >
      {loggerUd ? FIRMA_DASHBOARD.top.loggerUd : FIRMA_DASHBOARD.top.logUd}
    </button>
  );
}
