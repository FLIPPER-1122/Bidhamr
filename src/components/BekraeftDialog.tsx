"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { NETVAERKSFEJL } from "@/lib/auktionRegler";

// Generel bekræftelsesdialog til uigenkaldelige handlinger.
//
// Bygget over admin/ConfirmDialog, men med to forskelle: handlingen er et
// almindeligt kald frem for en form action, og en fejl lukker ikke dialogen -
// den vises inde i den, så brugeren kan prøve igen uden at miste konteksten.

export type BekraeftSvar = { fejl?: string; rolig?: string; bliv?: boolean } | void;

type Props = {
  triggerLabel: string;
  triggerClassName?: string;
  triggerIcon?: ReactNode;
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Returnér { fejl } for at vise en fejl i dialogen i stedet for at lukke.
   *  { rolig }: en rolig besked (fx "Det er allerede gjort") med en knap,
   *  der lukker dialogen og kalder onSuccess (som opdaterer siden).
   *  { bliv: true }: dialogen bliver åben uden besked (fx fordi den nu viser
   *  en advarsel, der skal bekræftes). */
  onConfirm: () => Promise<BekraeftSvar>;
  /** Kaldes når handlingen er gået godt og dialogen er lukket. */
  onSuccess?: () => void;
  /** Ekstra indhold (fx felter) mellem beskrivelsen og knapperne. */
  children?: ReactNode;
  /** Deaktiverer bekræft-knappen, fx indtil et påkrævet felt er udfyldt. */
  confirmDisabled?: boolean;
  /** Tekst på knappen ved en rolig besked. */
  roligKnap?: string;
  /** Tjek før dialogen åbnes. Returnér false for at blive i formularen
   *  (fx fordi et felt er ugyldigt og nu er markeret). */
  foerAabning?: () => boolean;
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
  foerAabning,
  roligKnap = "Opdater siden",
}: Props) {
  const [open, setOpen] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const [rolig, setRolig] = useState<string | null>(null);
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
    setRolig(null);
  }

  function bekraeft() {
    setFejl(null);
    setRolig(null);
    startTransition(async () => {
      let svar: BekraeftSvar;
      try {
        svar = await onConfirm();
      } catch (err) {
        // Fx afbrudt forbindelse. Uden catch ville hele siden skifte til
        // fejlsiden; i stedet vises fejlen i dialogen.
        console.error("Handlingen fejlede:", err);
        setFejl(NETVAERKSFEJL);
        return;
      }
      if (svar && svar.fejl) {
        setFejl(svar.fejl);
        return;
      }
      if (svar && svar.rolig) {
        setRolig(svar.rolig);
        return;
      }
      if (svar && svar.bliv) return;
      setOpen(false);
      onSuccess?.();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (foerAabning && !foerAabning()) return;
          setOpen(true);
        }}
        className={
          triggerClassName ??
          "btn btn-primaer"
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
              className="text-lg font-bold text-tekst"
            >
              {title}
            </h2>
            {description && (
              <p className="mt-1.5 text-sm text-tekst-daempet">{description}</p>
            )}

            {children && <div className="mt-5">{children}</div>}

            {fejl && (
              <p className="mt-4 rounded-lg border border-fejl-kant bg-fejl-bg px-3 py-2 text-sm text-fejl-tekst">
                {fejl}
              </p>
            )}

            {rolig && (
              <div role="status" className="mt-4 border border-info-kant bg-info-bg px-3 py-3 text-sm text-info-tekst">
                <p>{rolig}</p>
                <button
                  type="button"
                  onClick={() => {
                    luk();
                    onSuccess?.();
                  }}
                  className="btn btn-sekundaer btn-lille mt-3"
                >
                  {roligKnap}
                </button>
              </div>
            )}

            {/* Mobil: knapperne under hinanden i fuld bredde (lange danske
                knaptekster må ikke skubbe "Annullér" ud af dialogen). */}
            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={luk}
                disabled={pending}
                className="btn btn-sekundaer h-auto min-h-11 whitespace-normal"
              >
                {cancelLabel}
              </button>
              <button
                ref={bekraeftRef}
                type="button"
                onClick={bekraeft}
                disabled={pending || confirmDisabled || !!rolig}
                className="btn btn-primaer h-auto min-h-11 whitespace-normal"
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
