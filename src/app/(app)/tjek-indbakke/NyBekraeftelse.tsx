"use client";

import { useState } from "react";
import GensendBekraeftelse from "@/components/konto/GensendBekraeftelse";
import { FELT, LABEL } from "@/components/konto/felter";

// Ny bekræftelsesmail, når linket er udløbet, eller man er kommet hertil
// uden at have oprettet kontoen i denne browser.
export default function NyBekraeftelse({ startEmail }: { startEmail: string }) {
  const [email, setEmail] = useState(startEmail);
  return (
    <div className="w-full space-y-3">
      <div>
        <label htmlFor="ny-bekraeftelse-email" className={LABEL}>
          Din e-mail
        </label>
        <input
          id="ny-bekraeftelse-email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={`mt-1.5 ${FELT}`}
        />
      </div>
      <GensendBekraeftelse email={email.trim()} />
    </div>
  );
}
