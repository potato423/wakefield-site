# Flowpod website

The only active Flowpod website source in this repository is this folder. `public/` contains the site, the live 2D flow preview, and the sample images. The root GitHub Pages entry is a legacy redirect.

## Run and deploy

```sh
npm install
npm run build
npm run dev
npm run deploy
```

Cloudflare Workers serves the static files in `public/`. The production domain is `flowpod.online`.

## Beta signup

The form posts to FormSubmit, which emails the owner's inbox. FormSubmit requires the owner to activate the destination address from its first confirmation email. Until activation is confirmed, do not describe an AJAX response alone as proof that an email arrived. If an online submission fails, the visitor sees a prepared email draft as a fallback. No model file is uploaded or stored by this site.

To change the destination, update the FormSubmit endpoint in `public/app.js`, the fallback mailto link, and the contact/privacy links. Then activate the new destination with FormSubmit before relying on it.

The displayed prices are proposals. The public site offers no checkout or engineering drag/lift analysis.
