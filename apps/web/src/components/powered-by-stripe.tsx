import Image from "next/image";

// The OFFICIAL "Powered by Stripe" badge — Stripe's own brand SVG, unmodified.
// Stripe's brand policy lets a business that processes on Stripe display it and
// asks that it link to stripe.com, which this does. Distinct from the older
// text-only trust badge it replaced; this is the full lockup for payment
// surfaces (billing, registration checkout) and the public footer.
//
// Two fixed-fill variants ship in the brand kit: `blurple` for light
// backgrounds, `white` for dark. A placement passes the one that fits its
// ground — there is no runtime theme swap here on purpose.
export function PoweredByStripe({
  variant = "blurple",
  width = 120,
  className,
}: {
  variant?: "blurple" | "white";
  width?: number;
  className?: string;
}) {
  return (
    <a
      href="https://stripe.com"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Powered by Stripe"
      className={className}
    >
      <Image
        src={`/stripe/powered-by-stripe-${variant}.svg`}
        alt="Powered by Stripe"
        width={width}
        height={Math.round((width * 34) / 150)}
        unoptimized
      />
    </a>
  );
}
