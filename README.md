# Wake

Landing page for a product idea: **upload a 3D model you already own, pick air or water, and get a clip of it moving in real flow.**

Aimed at car, ship and plane model enthusiasts — the people with models on a shelf. The point is not engineering numbers (no drag/lift reports), it is the visual: smoke wrapping a real car body, a wake shedding behind a hull, vortices trailing a wing. Everything on the page is computed live in the browser, not video.

`Wake` is the brand name. `wake` is both the wake behind a body and *waking* a still model. Tagline: **Give it wind. Give it water.** Custom domain: **wake.film**.

## Run it

No build step, no dependencies, no framework.

- Serve the folder any way you like: `python -m http.server 8000`, then open `http://localhost:8000`
- Or push to any static host (GitHub Pages, Cloudflare Pages, Netlify drop)

Note: opening `index.html` straight from `file://` will not work, because the page loads `wakefield-fluid.js` and the sprite PNGs under CORS rules. Use a local server. (Headless captures need `--allow-file-access-from-files` or the sprite masks fail silently and only dark silhouettes composite.)

## Structure

| File | What it is |
|---|---|
| `index.html` | The whole page: hero, proof strip, how it works, outputs, pricing, beta intake, footer. |
| `wakefield-fluid.js` | GPU fluid solver (WebGL). No dependencies. Exposes `window.WakefieldFluid.create({...})`. |
| `assets/ferrari-body.png` | Orthographic side view of the Ferrari 458, alpha-thresholded into the flow-field solid mask. |
| `assets/sailship-body.png` | Quaternius sail ship (CC0), side view, same mask treatment. |
| `assets/jet-body.png` | Innerscene regional jet (CC0), side view, nose into the wind. |
| `assets/out-film.png` / `out-motion.png` / `out-stills.png` | Real solver frames cropped for the three output cards (car / plane / ship). |
| `favicon.svg` | Brand mark (two wind lines). |
| `CNAME` | Custom domain for GitHub Pages (`wake.film`). |

Page sections in order: hero with live demo (Coupe / Hull / Plane tabs) -> proof strip (Real solver / The fine stuff / Air + water) -> 01 how it works + what it runs on -> 02 what you get -> 03 pricing -> 04 join the beta.

## How the fluid works

`wakefield-fluid.js` is a stable-fluids Navier-Stokes solver (Stam 1999 / GPU Gems ch.38, same family as Taichi and GAMES201). Per frame:

1. **Advect** velocity and dye with a semi-Lagrangian pass.
2. **Solid mask**: the model silhouette is a real obstacle. Each PNG is thresholded by alpha and rasterized into the mask, so smoke wraps the actual geometry (roof separation, rear wake, wingtip vortices).
3. **Inflow** is pinned at the inlet; **vorticity confinement** keeps curls alive; **pressure projection** (Jacobi, 26 iterations) enforces incompressibility, which is what makes the wake behind the hull look physical.
4. **Display pass** composites the colored body over the dye field; foreground smoke keeps partial opacity so it drifts in front of the model. Underwater dye is depth-shifted toward blue so the sea reads as water, not smoke.
5. Car scenes inject dye at the tail each frame, forming a vortex street; the plane scene injects a counter-rotating wingtip vortex pair; the hull scene keeps bow foam on the waterline with droplet spray and a deep-blue under-bow current.

Interaction: dragging on the canvas splats velocity into the field (stirring). Scenes pause when scrolled out of view (IntersectionObserver) to save battery. WebGL2 with half-float textures, WebGL1 fallback.

## Things worth knowing before editing

**1. The email forms are a fake door.**
`FORM_ENDPOINT` near the bottom of `index.html` is an empty string. With it empty, submitting only writes to `localStorage` and shows a success state. Point it at Formspree / Tally / a Google Apps Script webhook to actually collect beta signups. The beta form also captures which model the person has and whether they want air or water.

**2. The demo vehicles are real licensed models.**
Ferrari 458 Italia by vicent091036, CC-BY, via the three.js examples. Sail ship by Quaternius, CC0. Regional jet by Innerscene, CC0. Attribution is in the page footer. If you swap a model, re-render the side view, re-threshold the alpha, and keep the credit.

**3. Honesty line.**
The page says "the same physics a wind tunnel runs" on purpose: this is a 2D visual simulation, not an engineering-grade 3D CFD export. Do not add drag/lift claims without a real solver behind them.

**4. No bundler, no npm.**
Deliberate: the page must be openable from any static host and editable by anyone.

## Status

- Published on GitHub Pages: https://potato423.github.io/wakefield-site/ (custom domain `wake.film` via the `CNAME` file)
- Fake door, no backend, beta signups go to `localStorage` until `FORM_ENDPOINT` is wired.
- Positioning: car / ship / plane model enthusiasts; the live hero demo is the credibility proof, the output cards are the product.
