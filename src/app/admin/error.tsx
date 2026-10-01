"use client"; // Fejlgrænser skal være klientkomponenter

import Link from "next/link";
import { useEffect } from "react";

// Sidste udvej i admin: vises, hvis en side eller en action kaster en fejl,
// der ikke er blevet til en { fejl }-besked.
export default function AdminFejl({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h2 className="text-xl font-bold text-neutral-900">Noget gik galt</h2>
      <p className="mt-2 text-sm text-neutral-500">
        Siden kunne ikke vises. Prøv igen, eller kontakt en udvikler.
        {error.digest && (
          <span className="mt-1 block text-xs text-neutral-400">Fejlkode: {error.digest}</span>
        )}
      </p>
      <div className="mt-6 flex items-center justify-center gap-4">
        <button
          type="button"
          onClick={() => retry()}
          className="inline-flex items-center justify-center rounded-lg border border-neutral-300 bg-white px-5 py-2.5 text-sm font-semibold text-neutral-900 transition-colors hover:bg-neutral-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
        >
          Prøv igen
        </button>
        <Link href="/admin" className="text-sm font-medium text-groen hover:underline">
          Til oversigten
        </Link>
      </div>
    </div>
  );
}
