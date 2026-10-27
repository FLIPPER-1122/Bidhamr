"use client";

import { useEffect, useRef, useState } from "react";
import { HENVISNING_TEKST as T } from "@/lib/tekster/henvisning";

// Henvis en ven: linket, "Kopiér link" og "Del" (systemets delingsmenu, hvor
// den findes - ellers kopieres linket).
async function kopier(tekst: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(tekst);
      return true;
    }
  } catch {
    // Prøv reserveløsningen nedenfor.
  }
  try {
    const felt = document.createElement("textarea");
    felt.value = tekst;
    felt.setAttribute("readonly", "");
    felt.style.position = "fixed";
    felt.style.opacity = "0";
    document.body.appendChild(felt);
    felt.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(felt);
    return ok;
  } catch {
    return false;
  }
}

export default function DelLink({ url }: { url: string }) {
  const [status, setStatus] = useState<"" | "ok" | "fejl">("");
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  function vis(s: "ok" | "fejl") {
    setStatus(s);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setStatus(""), 2500);
  }

  async function kopierKlik() {
    vis((await kopier(url)) ? "ok" : "fejl");
  }

  async function delKlik() {
    try {
      if (navigator.share) {
        await navigator.share({ title: T.delTitel, text: T.delTekst, url });
        return;
      }
    } catch (err) {
      // Brugeren lukkede delingsmenuen.
      if (err instanceof DOMException && err.name === "AbortError") return;
    }
    vis((await kopier(url)) ? "ok" : "fejl");
  }

  return (
    <div>
      <label htmlFor="henvisning-link" className="text-[15px] font-medium text-tekst-daempet">
        {T.linkLabel}
      </label>
      <input
        id="henvisning-link"
        type="text"
        readOnly
        value={url}
        onFocus={(e) => e.currentTarget.select()}
        className="mt-1 block min-h-11 w-full rounded-lg border border-kant-staerk bg-white px-3 text-[15px] text-tekst"
      />
      <div className="mt-3 flex flex-wrap gap-3">
        <button type="button" onClick={kopierKlik} className="btn btn-primaer">
          {status === "ok" ? "Kopieret" : T.kopier}
        </button>
        <button type="button" onClick={delKlik} className="btn btn-sekundaer">
          {T.del}
        </button>
      </div>
      <p role="status" aria-live="polite" className={status ? "mt-2 text-sm text-tekst-daempet" : "sr-only"}>
        {status === "ok" ? T.kopieret : status === "fejl" ? T.kunneIkkeKopiere : ""}
      </p>
    </div>
  );
}
