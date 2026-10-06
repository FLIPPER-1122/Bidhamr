"use client";

import { FejlSide } from "@/components/betaling/SideTilstande";
import { useRapporterFejl } from "@/components/drift/useRapporterFejl";

export default function Fejl({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  // Logges til /admin/drift (kun sti, besked og digest).
  useRapporterFejl(error);
  return <FejlSide retry={retry} />;
}
