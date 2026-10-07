import { SideSkelet } from "@/components/Skeletter";

// Dynamisk side (CSP-nonce): uden en loading-grænse prefetcher Next den
// slet ikke, og et klik viser intet, før serveren har bygget hele siden.
export default function Loading() {
  return <SideSkelet />;
}
