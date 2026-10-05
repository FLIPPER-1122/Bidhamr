"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function useLogUd(efter?: () => void) {
  const router = useRouter();
  const [loggerUd, setLoggerUd] = useState(false);

  async function logUd() {
    setLoggerUd(true);
    await createClient().auth.signOut();
    efter?.();
    router.push("/login");
    router.refresh();
  }

  return { logUd, loggerUd };
}
