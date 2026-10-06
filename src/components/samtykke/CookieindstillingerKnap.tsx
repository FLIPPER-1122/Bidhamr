"use client";

import { aabnCookieindstillinger } from "@/lib/samtykkeKlient";

// Åbner cookieindstillingerne, så man altid kan ændre eller trække sit
// samtykke tilbage (footer, /cookies, admin-menuen). Udseendet styres af den,
// der bruger knappen.
export default function CookieindstillingerKnap({
  className,
  children = "Cookieindstillinger",
  vedKlik,
}: {
  className?: string;
  children?: React.ReactNode;
  // Fx at lukke en mobilmenu, så den ikke ligger over indstillingerne.
  vedKlik?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        vedKlik?.();
        aabnCookieindstillinger();
      }}
      className={className}
    >
      {children}
    </button>
  );
}
