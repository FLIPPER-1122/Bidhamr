import type { ReactNode } from "react";

// Fejlboks på admin-sider (DESIGN-fejlfarver, role="alert"). Erstatter de
// gamle red-50-bokse. `hvad` = fx "Sagerne" -> "Sagerne kunne ikke hentes."
export default function AdminFejl({
  hvad,
  children,
  detalje,
}: {
  hvad?: string;
  children?: ReactNode;
  detalje?: string | null;
}) {
  return (
    <div role="alert" className="rounded-[14px] border border-fejl-kant bg-fejl-bg px-4 py-3 text-sm text-fejl-tekst sm:px-5">
      {children ?? (
        <p>
          <span className="font-semibold">{hvad ?? "Siden"} kunne ikke hentes.</span> Prøv at genindlæse siden.
        </p>
      )}
      {detalje && <p className="mt-1 break-words text-xs opacity-90">{detalje}</p>}
    </div>
  );
}
