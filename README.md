# Wakefield

Landing page for a product idea: **upload a 3D model you already own, pick air or water, and get a clip of it moving in real flow.**

Aimed at figure/statue collectors, scale model car people, and ship model builders. The point is not engineering numbers (no drag/lift reports), it is the visual: smoke wrapping a real car body, a wake shedding behind a hull, cloth and hair reacting to air. Everything on the page is computed live in the browser, not video.

`Wakefield` is the brand name. `wake` is both the wake behind a body and *waking* a still model; `field` is the flow field. Tagline: **Give it wind. Give it water.**

## Run it

No build step, no dependencies, no framework.

- Serve the folder any way you like: `python -m http.server 8000`, then open `http://localhost:8000`
- Or push to any static host (GitHub Pages, Cloudflare Pages, Netlify drop)

Note: opening `index.html` straight from `file://` will not work, because the page loads `wakefield-fluid.js` and `assets/ferrari-body.png` as ES modules / fetch-free assets under CORS rules. Use a local server.

## Structure

| File | What it is |
|---|---|
| `index.html` | The whole page: hero, proof strip, how it works, outputs, use cases, pricing, beta intake, footer. |
| `wakefield-fluid.js` | GPU fluid solver (WebGL). No dependencies. Exposes `window.WakefieldFluid.create({...})`. |
| `assets/ferrari-body.png` | Orthographic side view of the Ferrari 458, alpha-thresholded into the flow-field solid mask. |
| `favicon.svg` | Brand mark (two wind lines). |

Page sections in order: hero with live demo (Coupe / Figure / Hull tabs) -> proof numbers -> 01 how it works -> 02 what you get -> 03 what people run -> 04 pricing -> 05 join the beta.

## How the fluid works

`wakefield-fluid.js` is a stable-fluids Navier-Stokes solver (Stam 1999 / GPU Gems ch.38, same family as Taichi and GAMES201). Per frame:

1. **Advect** velocity and dye with a semi-Lagrangian pass.
2. **Solid mask**: the model silhouette is a real obstacle. The Ferrari PNG is thresholded by alpha and rasterized into the mask, so smoke wraps the actual car geometry (roof separation, rear wake).
3. **Inflow** is pinned at the inlet; **vorticity confinement** keeps curls alive; **pressure projection** (Jacobi, 26 iterations) enforces incompressibility, which is what makes the wake behind the hull look physical.
4. **Display pass** composites the colored car body over the dye field; foreground smoke keeps 22% opacity so it drifts in front of the car.
5. Car scenes inject dye at the tail each frame, forming a vortex street.

Interaction: dragging on the canvas splats velocity into the field (stirring). Scenes pause when scrolled out of view (IntersectionObserver) to save battery. WebGL2 with half-float textures, WebGL1 fallback.

The hull wake in section 03 is the same solver with a hand-drawn hull silhouette; the ship bobs and pitches with the wave while its mask is rebuilt each frame.

## Things worth knowing before editing

**1. The email forms are a fake door.**
`FORM_ENDPOINT` near the bottom of `index.html` is an empty string. With it empty, submitting only writes to `localStorage` and shows a success state. Point it at Formspree / Tally / a Google Apps Script webhook to actually collect beta signups. The beta form also captures which model the person has and whether they want air or water.

**2. The demo vehicle is a real licensed model.**
Ferrari 458 Italia by vicent091036, CC-BY, via the three.js examples. Attribution is in the page footer. If you swap the car, re-render the side view, re-threshold the alpha, and keep the credit.

**3. Honesty line.**
The page says "physics-inspired motion" on purpose: this is a 2D visual simulation, not an engineering-grade 3D CFD export. Do not add drag/lift claims without a real solver behind them.

**4. No bundler, no npm.**
Deliberate: the page must be openable from any static host and editable by anyone.

## Status

- Published on GitHub Pages: https://potato423.github.io/wakefield-site/
- Fake door, no backend, beta signups go to `localStorage` until `FORM_ENDPOINT` is wired.
- Positioning: figurines and collectibles are the main scene, the real car model is the credibility proof, hulls are the second proof.
