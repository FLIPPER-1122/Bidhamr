import type { Metadata } from "next";
import Tekstside from "@/components/Tekstside";
import CookieindstillingerKnap from "@/components/samtykke/CookieindstillingerKnap";
import { COOKIES } from "@/lib/tekster/sider/cookies";

export const metadata: Metadata = {
  title: COOKIES.titel,
  description: COOKIES.metabeskrivelse,
};

export default function CookiesPage() {
  return (
    <Tekstside
      side={COOKIES}
      ekstra={{
        "dit-valg": (
          <CookieindstillingerKnap className="btn btn-sekundaer mt-5 w-full sm:w-auto" />
        ),
      }}
    />
  );
}
