import type { ReactNode } from "react";

// Fælles sideskelet for alle admin-sider (docs/ADMIN-REDESIGN.md 4.1):
// sidehoved -> faner -> filtre/søgning -> indhold -> sideskift.
// Listesider er max-w-6xl, detaljesider (detalje) max-w-5xl.
export default function AdminSide({
  children,
  detalje = false,
  className = "",
}: {
  children: ReactNode;
  detalje?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`mx-auto w-full min-w-0 space-y-5 px-4 pb-16 pt-5 sm:px-6 sm:pt-6 ${detalje ? "max-w-5xl" : "max-w-6xl"} ${className}`}
    >
      {children}
    </div>
  );
}
