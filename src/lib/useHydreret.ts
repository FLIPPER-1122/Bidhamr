import { useSyncExternalStore } from "react";

// true først, når komponenten er hydreret i browseren (JavaScript kører).
//
// Bruges til at slå send-knappen fra i formularer med onSubmit-handler: før
// hydrering sender browseren ellers formularen helt almindeligt, og uden
// method="post" bliver det en GET, så felterne (e-mail, adgangskode, CPR,
// adresse ...) ender i adressen, browserhistorikken og serverlogs.
//
// Mønster i hver formular:
//   const hydreret = useHydreret();
//   <form onSubmit={...} method="post">
//     <button type="submit" disabled={sender || !hydreret}>
//
// En slået-fra send-knap stopper også Enter i et felt (implicit submit).
// Serveren renderer altid false, browseren true efter hydrering, så der er
// ingen hydreringsfejl.
const ingenAbonnement = () => () => {};

export function useHydreret(): boolean {
  return useSyncExternalStore(ingenAbonnement, () => true, () => false);
}
