'use client';

import dynamic from 'next/dynamic';

/**
 * The card form, fetched only when it mounts (#365 review): Stripe's packages pushed the review
 * route's first load past its 139 kB budget, and only a card checkout needs them.
 *
 * It has to be a client component with `ssr: false`. `next/dynamic` called from the server page
 * still server-renders the form and lists its chunk in the page's entry — measured: the review route
 * stayed at 140 kB with the Stripe chunk in its manifest. Nothing is lost by skipping the server
 * render: the Payment Element is an iframe Stripe.js mounts in the browser anyway.
 */
export const CardPaymentLazy = dynamic(
  () => import('./card-payment').then((module) => module.CardPayment),
  { ssr: false },
);
