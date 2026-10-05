"use client"; // Fejlgrænser skal være klientkomponenter

import FejlGraense from "@/components/fejl/FejlGraense";

// Fanger fejl på alle sider under (app), der ikke har deres egen error.tsx
// (fx /auktioner, /auktion/[id], /mine-handler, /profil/[id]). Topbar og
// footer bliver stående, da (app)/layout.tsx ligger uden for grænsen.
export default function Fejl({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return <FejlGraense error={error} retry={retry} />;
}
