// Id på betalingsformularen (Stripes Payment Element i CheckoutBetaling).
// Ligger for sig selv, så CheckoutSide kan bruge det uden at hente Stripe-
// komponenten med i sidens første JavaScript (den indlæses med next/dynamic).
export const CHECKOUT_FORM = "checkout-betal";
