# Landing page

The product landing page is a separate React application in `web/landing`. It introduces private recurring Zcash payments and includes an illustrative agreement-to-receipt walkthrough. It does not connect a wallet, call the payment API, or move funds. The product name is provisional.

## Run locally

Requires the same Node and npm versions as the funding frontend.

```sh
npm ci --prefix web
npm --prefix web run dev:landing
```

Open http://127.0.0.1:4174/. The existing funding application continues to use its own entry point and port.

```sh
npm --prefix web run build:landing
npm --prefix web run preview:landing
```

The build writes to `web/dist-landing`. The preview server uses port 4174, so stop the development server before starting it. Production hosting must serve the output directory at the origin root; the font and image URLs are root-relative. The build output contains no secrets and requires no runtime backend credentials.

## Interface and accessibility

- The hero combines a transparent generated sculpture with an HTML agreement card. CSS handles entrance motion, light sweep, and subtle movement; pointer movement adds parallax on mouse devices.
- The walkthrough tabs support pointer activation, Up/Down arrows, Home, and End. Example amounts use TAZ and are labeled as testnet examples.
- A Pause motion control and `prefers-reduced-motion` stop animation. All content remains visible with reduced motion.
- The phone navigation and native FAQ disclosures work without backend services.
- Download PDF invokes the browser's print dialog. Print styles reveal all sections and capture the current walkthrough state.

## Assets

DM Sans and Instrument Serif are served locally under `web/landing/public/fonts`, with their SIL Open Font License notices. The cobalt sculpture is generated artwork in `web/landing/public/sealed-sculpture.png`. The folded brand mark is an SVG in the same public directory. No third-party font or image requests are required at runtime.

## Integration boundary

The landing calls to action navigate within the page. Connect them to the application only when an authenticated user flow is ready. API capabilities belong on the application server, never in browser code. Keep illustration state separate from live signer observations and supplier entitlement checks.
