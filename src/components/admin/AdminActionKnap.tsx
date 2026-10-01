"use client";

import { useState, useTransition } from "react";

// En enkelt knap, der kalder en admin-action uden bekræftelsesdialog og viser
// en eventuel { fejl } fra actionen under knappen.
type Props = {
  label: string;
  className: string;
  action: (formData: FormData) => Promise<void | { fejl: string } | { ok: true }>;
  hiddenFields: Record<string, string>;
};

export default function AdminActionKnap({ label, className, action, hiddenFields }: Props) {
  const [pending, startTransition] = useTransition();
  const [fejl, setFejl] = useState<string | null>(null);

  function handleSubmit(formData: FormData) {
    startTransition(async () => {
      setFejl(null);
      const res = await action(formData);
      if (res && "fejl" in res) setFejl(res.fejl);
    });
  }

  return (
    <form action={handleSubmit}>
      {Object.entries(hiddenFields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <button
        type="submit"
        disabled={pending}
        aria-busy={pending}
        className={`${className} disabled:opacity-50`}
      >
        {label}
      </button>
      {fejl && (
        <p role="alert" className="mt-1 max-w-[220px] text-xs text-red-700">
          {fejl}
        </p>
      )}
    </form>
  );
}
