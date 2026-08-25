"use client";

import { useState, useTransition } from "react";
import { confirmReceipt } from "@/app/actions/confirmReceipt";

export default function BekræftModtagelseKnap({
  auktionId,
}: {
  auktionId: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleClick() {
    setError(null);
    startTransition(async () => {
      const result = await confirmReceipt(auktionId);
      if (result?.error) {
        setError(result.error);
      }
    });
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        className="rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#d62b38] disabled:opacity-50"
      >
        {pending ? "Bekræfter…" : "Bekræft modtagelse"}
      </button>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
