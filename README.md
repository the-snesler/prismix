# Prismix

AI image generation gallery with multi-model support. Runs mostly in the user's browser, proxies requests to Replicate via a Cloudflare Worker.

<img width="1918" height="1257" alt="image" src="https://github.com/user-attachments/assets/a27ca757-7947-4269-96cd-82ca45b20f3e" />

## Features

- Multiple concurrent generations from different models, with support for many providers (Replicate, OpenAI, and Google)
- Editor view: iterate on a single image, with comparison between original and new variations & edit history
- Semantic search: easily find past images in the gallery, with embeddings done locally in the background
- Text model support: automatically improve prompts, generate prompts from images, and create variations on prompts
- Upscaling model support: generate high-resolution images from low-resolution inputs
- Add literally any image model from Replicate, using text models to adapt to different input and output formats
- Reference image support for editing workflows
- Custom aspect ratios and resolutions
- Masonry gallery layout with grid/list views
- Drag & drop images from gallery to reference inputs
- Multi-select gallery actions: bulk delete, bulk download, and bulk attach to prompt references

## Stack

- React Router 7
- Cloudflare Workers
- Replicate API
- Tailwind CSS
- Zustand

## Screenshots

<img width="1942" height="1357" alt="image" src="https://github.com/user-attachments/assets/1fe4e1b5-8d45-47cc-bc52-038f9348a563" />

<img width="1942" height="1357" alt="Screenshot 2026-05-04 at 10-22-17 Prismix - AI Image Generation" src="https://github.com/user-attachments/assets/85d6d8b4-aae6-413e-8983-36e206ab6a87" />

## Setup

```bash
pnpm install
```

## Development

```bash
pnpm dev
```

## Deploy

```bash
pnpm build
wrangler deploy
```

## Self-hosting

Prismix can also run as a single-user server that keeps your gallery, reference images, and settings on disk instead of in the browser. Images live under `/data` (SQLite plus image files), so they survive browser resets and follow you across devices. Generations run on the server, so they finish even if you close the tab.

To move a gallery between the browser-only app and a server, use **Settings → Data**: export a zip from one and import it into the other. Both use the same archive format. The server build uploads archives in small resumable chunks (8 MB, halved automatically if a proxy rejects them as too large), so multi-gigabyte imports work behind reverse proxies and survive dropped connections; the import itself then runs on the server, and the page shows its progress.

```bash
docker compose up -d --build   # http://127.0.0.1:8787
```

Or without Compose:

```bash
docker build -t prismix .
docker run -d -p 127.0.0.1:8787:8787 -v prismix-data:/data prismix
```

There is no authentication, and your provider API keys are stored on the server. Keep the port bound to `127.0.0.1` (as above). To reach it from other machines, put it behind a reverse proxy that adds authentication, or use a private network such as Tailscale. Don't expose it directly to the internet.

Configuration (environment variables):

| Variable                 | Default        | Purpose                                       |
| ------------------------ | -------------- | --------------------------------------------- |
| `DATA_DIR`               | `/data`        | Database and stored images                    |
| `PORT`                   | `8787`         | Listen port                                   |
| `HOST`                   | `0.0.0.0`      | Listen address (inside the container)         |
| `STATIC_DIR`             | `build/client` | Built web app, relative to the work dir       |
| `GENERATION_CONCURRENCY` | `4`            | Simultaneous generation requests per provider |

Back up by copying the data volume while the container is stopped.

Without Docker (Node 24+):

```bash
VITE_BACKEND=server pnpm build
pnpm build:server
DATA_DIR=./data pnpm start:server
```

For development against the server, run `pnpm start:server` as above and `VITE_BACKEND=server pnpm dev` in another terminal. Vite proxies `/api` to port 8787.
