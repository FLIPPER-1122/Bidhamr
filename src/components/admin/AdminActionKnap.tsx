"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { visKvittering } from "@/components/admin/Kvittering";

// Hurtighandling: én knap, der kalder en admin-action uden bekræftelse
// (kun til ufarlige handlinger) og viser en kvittering. En eventuel
// { fejl } fra actionen vises under knappen. Farlige handlinger og handlinger,
// der flytter penge, bruger ConfirmDialog.
type Props = {
  label: string;
  className?: string;
  action: (formData: FormData) => Promise<void | { fejl: string } | { ok: true }>;
  hiddenFields: Record<string, string>;
  kvittering?: string;
  // Gå videre bagefter (fx til næste element i køen).
  efterHref?: string;
};

export default function AdminActionKnap({ label, className, action, hiddenFields, kvittering, efterHref }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [fejl, setFejl] = useState<string | null>(null);

  function handleSubmit(formData: FormData) {
    startTransition(async () => {
      setFejl(null);
      const res = await action(formData);
      if (res && "fejl" in res) {
        setFejl(res.fejl);
        return;
      }
      if (kvittering) visKvittering(kvittering);
      if (efterHref) router.push(efterHref);
      else router.refresh();
    });
  }

  return (
    <form action={handleSubmit} className="min-w-0">
      {Object.entries(hiddenFields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <button
        type="submit"
        disabled={pending}
        aria-busy={pending}
        className={`${className ?? "btn btn-sekundaer btn-lille"} disabled:opacity-60`}
      >
        {pending && <span className="btn-spinner" aria-hidden="true" />}
        {label}
      </button>
      {fejl && (
        <p role="alert" className="mt-1 max-w-[260px] text-xs font-medium text-fejl-tekst">
          {fejl}
        </p>
      )}
    </form>
  );
}
