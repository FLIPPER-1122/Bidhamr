"use client"; // Fejlgrænser skal være klientkomponenter

import FejlGraense from "@/components/fejl/FejlGraense";

// Fanger fejl uden for (app) og admin (fx /coming-soon og /auth). Fejl i
// selve rodlayoutet fanges af global-error.tsx.
export default function Fejl({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return <FejlGraense error={error} retry={retry} />;
}
