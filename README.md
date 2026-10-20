# Wakefield (working title)

Landing page for a product idea: **upload a 3D model, get a short clip of it moving in wind or airflow.**

Aimed at figure/statue collectors and scale model car people. The point is not engineering numbers (no drag/lift reports), it is the visual: hair, cape, ribbon, cloth actually reacting to air. The site claims this is computed rather than a canned animation, and the car section exists as a live proof of that.

`Wakefield` is a working name (CFD term for the wake behind a body). Change it freely.

## Run it

No build step, no dependencies, no framework. One file.

- Double click `index.html`, or
- `python -m http.server 8000` in this folder and open `http://localhost:8000`

## Structure

Single file `index.html`. Roughly in this order:

| Section | What it is |
|---|---|
| Hero (`#scene`) | Live SVG stick-figure character. Hair strands, cape, and a wrist ribbon are all driven by one shared gust function. This is the main product demo. |
| `#why` | Three differentiators. The important one is "Real wind, not an AI filter", positioned against AI apps that paste a canned dance onto a photo. |
| Proof strip | Three research numbers (136 makes of a "frozen wind" figurine, $269k crowdfunded desktop wind tunnel, 28B+ views on collector content). |
| `#examples` | Second live scene: a coupe in a potential-flow field with a von Karman wake behind it. tag reads "Proof, computed flow". |
| Email capture | Two forms (`#form-hero`, `#form-final`). Currently a fake door. |

## Things worth knowing before editing

**1. The two animated scenes are real-time computed, not video or images.**
They are plain SVG paths recalculated every frame in JS. The hero uses a gust envelope `gust(t)`. The car section solves a cylinder potential-flow streamfunction (`etaOf`) numerically with bisection, then adds a decaying oscillating wake (`wakeEta`). If you change geometry constants, the streamlines can end up crossing the car body. The current values were tuned and verified so the closest streamline passes above the roof and below the floor.

**2. The email form is a fake door.**
`FORM_ENDPOINT` near the bottom is an empty string. With it empty, submitting only writes to `localStorage` and shows a success state. Point it at Formspree or Tally to actually collect emails.

**3. Copy voice rules.**
No em dashes. No "genuine question" / "I'd be happy to" style filler. Keep sentences short and concrete. The target reader is a hobbyist, not an engineer.

**4. Keep it single-file.**
No bundler, no npm, no framework. That is deliberate: the page is meant to be openable straight from disk and editable by anyone.

## Status

- Fake door, not published.
- No backend.
- Positioning settled on: figurines are the main scene, scale model cars are the credibility proof.
