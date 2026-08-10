# TurnitPlus GitHub preparation

Prepared from the uploaded `turnitplus-premium-v5(1).zip` for the private
`Apothrodice0/turnitplus0` repository.

Included:
- Next.js application source
- production assets under `public/data/`
- package-lock.json and build configuration

Excluded from GitHub:
- `node_modules/`
- `.next/`, `out/`, `.vercel/` and other generated output
- historical `release/` packages
- `turnitplus-site-v38.tar.gz`
- local evaluation/source corpora under `data/` and `corpus/`
- environment secrets (`.env*`, except `.env.example`)

Production configuration:
- Framework: Next.js 16.2.6
- Build: `npm run build`
- Node: `>=22.13.0 <23`
