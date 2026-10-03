"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";

// Generel bekræftelsesdialog til uigenkaldelige handlinger.
//
// Bygget over admin/ConfirmDialog, men med to forskelle: handlingen er et
// almindeligt kald frem for en form action, og en fejl lukker ikke dialogen -
// den vises inde i den, så brugeren kan prøve igen uden at miste konteksten.

type Props = {
  triggerLabel: string;
  triggerClassName?: string;
  triggerIcon?: ReactNode;
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Returnér { fejl } for at vise en fejl i dialogen i stedet for at lukke. */
  onConfirm: () => Promise<{ fejl?: string } | void>;
  /** Kaldes når handlingen er gået godt og dialogen er lukket. */
  onSuccess?: () => void;
  /** Ekstra indhold (fx felter) mellem beskrivelsen og knapperne. */
  children?: ReactNode;
  /** Deaktiverer bekræft-knappen, fx indtil et påkrævet felt er udfyldt. */
  confirmDisabled?: boolean;
};

export default function BekraeftDialog({
  triggerLabel,
  triggerClassName,
  triggerIcon,
  title,
  description,
  confirmLabel,
  cancelLabel = "Annullér",
  onConfirm,
  onSuccess,
  children,
  confirmDisabled = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const bekraeftRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    // Escape lukker - men ikke midt i en igangværende handling, hvor det
    // ville se ud som om man havde annulleret.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) luk();
    };
    window.addEventListener("keydown", onKey);

    // Baggrunden må ikke kunne scrolles bag dialogen.
    const forrigeOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = forrigeOverflow;
    };
  }, [open, pending]);

  // Fokus flyttes kun ind i dialogen, når den åbnes - ellers ville fokus
  // hoppe væk fra et felt, hver gang en handling starter eller slutter.
  // Er bekræft-knappen deaktiveret (påkrævede felter), får dialogens første
  // felt fokus i stedet.
  useEffect(() => {
    if (!open) return;
    const knap = bekraeftRef.current;
    if (knap && !knap.disabled) {
      knap.focus();
      return;
    }
    const foerste = dialogRef.current?.querySelector<HTMLElement>(
      "input:not([disabled]), textarea:not([disabled]), select:not([disabled])",
    );
    (foerste ?? dialogRef.current)?.focus();
  }, [open]);

  function luk() {
    setOpen(false);
    setFejl(null);
  }

  function bekraeft() {
    setFejl(null);
    startTransition(async () => {
      const svar = await onConfirm();
      if (svar && "fejl" in svar && svar.fejl) {
        setFejl(svar.fejl);
        return;
      }
      setOpen(false);
      onSuccess?.();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          triggerClassName ??
          "inline-flex items-center gap-2 rounded-lg bg-orange-knap px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-orange-knap-mork"
        }
      >
        {triggerIcon}
        {triggerLabel}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => !pending && luk()}
        >
          <div
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="bekraeft-titel"
            className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-xl bg-white p-6 shadow-xl outline-none"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="bekraeft-titel"
              className="text-lg font-bold text-neutral-900"
            >
              {title}
            </h2>
            {description && (
              <p className="mt-1.5 text-sm text-neutral-600">{description}</p>
            )}

            {children && <div className="mt-5">{children}</div>}

            {fejl && (
              <p className="mt-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
                {fejl}
              </p>
            )}

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={luk}
                disabled={pending}
                className="rounded-lg bg-neutral-100 px-4 py-2.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-200 disabled:opacity-50"
              >
                {cancelLabel}
              </button>
              <button
                ref={bekraeftRef}
                type="button"
                onClick={bekraeft}
                disabled={pending || confirmDisabled}
                className="rounded-lg bg-orange-knap px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-orange-knap-mork disabled:opacity-50"
              >
                {pending ? "Arbejder…" : confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
