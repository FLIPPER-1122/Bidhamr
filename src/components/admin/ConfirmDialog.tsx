"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";

type Props = {
  triggerLabel: string;
  triggerIcon?: ReactNode;
  triggerClassName?: string;
  title: string;
  description?: string;
  confirmLabel: string;
  action: (formData: FormData) => Promise<void>;
  hiddenFields: Record<string, string>;
  aarsagField?: { label: string; placeholder: string; required: boolean };
  varighedField?: boolean;
};

export default function ConfirmDialog({
  triggerLabel,
  triggerIcon,
  triggerClassName,
  title,
  description,
  confirmLabel,
  action,
  hiddenFields,
  aarsagField,
  varighedField,
}: Props) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function handleSubmit(formData: FormData) {
    startTransition(async () => {
      await action(formData);
      setOpen(false);
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          triggerClassName ??
          "inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-700 transition-colors"
        }
      >
        {triggerIcon}
        {triggerLabel}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => !pending && setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-bold text-neutral-900">{title}</h2>
            {description && (
              <p className="mt-1.5 text-sm text-neutral-500">{description}</p>
            )}

            <form action={handleSubmit} className="mt-4 space-y-4">
              {Object.entries(hiddenFields).map(([name, value]) => (
                <input key={name} type="hidden" name={name} value={value} />
              ))}

              {varighedField && (
                <div>
                  <label
                    htmlFor="varighed"
                    className="block text-sm font-medium text-neutral-700"
                  >
                    Hvor længe?
                  </label>
                  <select
                    id="varighed"
                    name="varighed"
                    required
                    className="mt-1.5 w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand bg-white"
                  >
                    <option value="1">1 dag</option>
                    <option value="7">7 dage</option>
                    <option value="permanent">Permanent</option>
                  </select>
                </div>
              )}

              {aarsagField && (
                <div>
                  <label
                    htmlFor="aarsag"
                    className="block text-sm font-medium text-neutral-700"
                  >
                    {aarsagField.label}
                  </label>
                  <textarea
                    id="aarsag"
                    name="aarsag"
                    required={aarsagField.required}
                    rows={3}
                    placeholder={aarsagField.placeholder}
                    className="mt-1.5 w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
                  />
                </div>
              )}

              <div className="flex justify-end gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  disabled={pending}
                  className="rounded-lg bg-neutral-100 px-4 py-2.5 text-sm font-medium text-neutral-700 hover:bg-neutral-200 transition-colors disabled:opacity-50"
                >
                  Annullér
                </button>
                <button
                  type="submit"
                  disabled={pending}
                  className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#d62b38] transition-colors disabled:opacity-50"
                >
                  {pending ? "Arbejder…" : confirmLabel}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
