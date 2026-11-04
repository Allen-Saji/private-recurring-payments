# Landing page

The product landing page lives in `web/landing` and is served with the account application at the same origin. It introduces private recurring Zcash payments, links to the service catalog and agent guide, and opens prefilled review access. Its agreement-to-receipt walkthrough remains labeled illustrative content; actual invoices and receipts live in authenticated workspaces.

## Run locally

Requires the same Node and npm versions as the funding frontend.

```sh
npm ci --prefix web
npm --prefix web run dev:landing
```

Open http://127.0.0.1:4174/ for standalone visual development. Use the unified application at http://localhost:4176 to exercise navigation, account access, services and funding.

```sh
npm --prefix web run build:landing
npm --prefix web run preview:landing
```

The build writes to `web/dist-landing`. The preview server uses port 4174, so stop the development server before starting it. Production hosting must serve the output directory at the origin root; the font and image URLs are root-relative. The build output contains no secrets and requires no runtime backend credentials.

## Interface and accessibility

- The hero combines a transparent generated sculpture with an HTML agreement card. CSS handles entrance motion, light sweep, and subtle movement; pointer movement adds parallax on mouse devices.
- The walkthrough tabs support pointer activation, Up/Down arrows, Home, and End. Example amounts use TAZ and are labeled as testnet examples.
- Animation automatically respects `prefers-reduced-motion`. There is no manual motion toggle; all content remains visible when the system requests reduced motion.
- The phone navigation and native FAQ disclosures work without backend services.
- The website has no floating Download PDF button. Native browser printing remains supported; invoice PDF export is a separate action inside the invoice toolbar.

## Assets

DM Sans and Instrument Serif are served locally under `web/landing/public/fonts`, with their SIL Open Font License notices. The cobalt sculpture is generated artwork in `web/landing/public/sealed-sculpture.png`. The folded brand mark, favicon variants, centered README logo and generated OG image are in the same public directory. No third-party font or image requests are required at runtime.

## Integration boundary

Explore Tandem opens the prefilled read-only review login. Browse services opens the public curated directory; supplier setup continues to company sign-in or account creation. For agents opens the public workflow and API guide. The gateway serves canonical/social metadata, crawlable summaries, JSON discovery and OpenAPI from the configured origin. Backend capabilities remain server-side. Illustration state stays separate from actual signer observations and supplier entitlement checks.
