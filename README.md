# Localleaf

[![CI](https://github.com/aalniak/localleaf/actions/workflows/ci.yml/badge.svg)](https://github.com/aalniak/localleaf/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A self-hosted, Overleaf-style LaTeX editor. Upload an Overleaf `.zip` (or start a blank project), edit in the
browser, compile with **full TeX Live**, and preview the PDF side by side, with SyncTeX in both directions.

There are no compile timeouts, no account, and your files stay on your machine.

## Quick start

Pick **one** of the two ways below. Both serve the editor at <http://localhost:4000>.

### Option A: Docker Compose (nothing else to install)

Requires [Docker](https://docs.docker.com/get-docker/) (Docker Desktop on Windows/macOS).

```bash
git clone https://github.com/aalniak/localleaf.git
cd localleaf
docker compose up -d --build
```

The first build downloads the TeX Live image (~5 GB, once). Projects are kept in the `localleaf-data` Docker
volume. Stop it with `docker compose down`, and update it with `git pull && docker compose up -d --build`.

### Option B: Node.js

Requires **Node.js 22.12+** and a LaTeX compiler. Localleaf picks the first one it finds:

| Compiler | How it's used | Notes |
|---|---|---|
| **Docker** (recommended) | Full TeX Live in the `texlive/texlive` image, in a long-lived helper container | Same toolchain as Overleaf. First compile pulls ~5 GB once. SyncTeX supported. |
| Local TeX Live / MiKTeX | `latexmk` on `PATH` | SyncTeX if `synctex` is on `PATH`. |
| Tectonic | `tectonic` on `PATH` | XeTeX-based; engine setting ignored; no SyncTeX. |

```bash
git clone https://github.com/aalniak/localleaf.git
cd localleaf
npm install
npm start            # builds the frontend, then serves http://localhost:4000
```

**No compiler yet?** `npm start` notices, and offers to install Docker for you (winget on Windows, Homebrew on
macOS, Docker's official install script on Linux) or to start it if it's installed but not running. It always
asks first. You can also run the assistant on its own with `npm run setup`. If you say no, Localleaf still
starts: you can edit, and the projects page explains how to add a compiler. Whatever you install is picked up
automatically, without restarting Localleaf. Set `LOCALLEAF_SKIP_SETUP=1` to skip the check.

Projects are stored in `./data`. Remove the helper container when you're done with
`docker rm -f localleaf-texlive`; it is recreated on demand.

### Using it

Open <http://localhost:4000>. Drag an Overleaf `.zip` onto the page (in Overleaf: *Menu → Download → Source*),
or click **New project**. Press `Ctrl+S` / `Ctrl+Enter` to compile.

You can also import from the command line (Option B): `npm run import -- path/to/project.zip "Optional name"`.

## Features

- **Projects dashboard**: create, import a `.zip` (a single wrapping folder is stripped and `__MACOSX` junk dropped),
  rename, download as `.zip`, delete.
- **Editor** (CodeMirror 6): LaTeX highlighting, search and replace (`Ctrl+F`), multiple files with per-file undo
  history, autosave, and autocompletion for commands, environments, `\ref{}` labels and `\cite{}` keys
  (from `\bibitem` and `.bib` files across the project).
- **File tree**: folders, new file/folder, upload (button or drag-and-drop from your desktop), rename/move
  (type a path with `/`), delete, *set as main document*, inline image preview.
- **Compile**: `Ctrl+S` / `Ctrl+Enter` / **Recompile** (pdfLaTeX, XeLaTeX or LuaLaTeX via `latexmk`), with
  bibliographies handled automatically. **From scratch** clears cached aux files first.
- **Fast draft**: compiles with `graphicx`'s `draft` option. Images become boxes, so builds take a few seconds.
- **Auto compile**: recompiles a moment after you stop typing.
- **Logs**: errors, warnings and bad boxes parsed from the log. Click one to jump to the line. Errors are also shown
  as gutter markers in the editor, and the raw log is available.
- **PDF viewer** (PDF.js): continuous scroll, lazy page rendering, zoom/fit, and it keeps your position across recompiles.
- **SyncTeX**: double-click the PDF to jump to the source line; the **→** button (or `Ctrl+Alt+→`) highlights
  the cursor's line in the PDF.

## How compiling works (and why it is fast)

With the Docker backend (`npm start` + Docker), Localleaf keeps one long-lived container named `localleaf-texlive` running and uses `docker exec`
for each compile, so there is no container start-up cost. For each compile:

1. The project is `rsync`ed into a working copy **inside** the container. Bind-mount I/O on Windows/macOS is slow,
   and this roughly halves pdfLaTeX time on image-heavy documents.
2. For pdfLaTeX/LuaLaTeX, `latexmk` runs the convergence passes (ToC, references, `LastPage`, BibTeX/Biber) in
   **`-draftmode`**, which skips writing the PDF and image streams. A single final pass then writes the PDF and
   SyncTeX data. The output is identical to a normal `latexmk` build.
3. The PDF, log and SyncTeX file are copied back to `data/projects/<id>/output/`.

Example: an 80-file report with ~12 MB of figures takes about 2 min 20 s with a plain `latexmk`
over a bind mount. In Localleaf it takes ~30 s cold and ~16 s per recompile, or ~3 s with *Fast draft*.

The all-in-one image (`docker compose up`) runs the same script directly, without `docker exec`.

## Configuration

Set these as environment variables (`npm start`) or in a `.env` file next to `docker-compose.yml` (Docker Compose).

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4000` | HTTP port |
| `LOCALLEAF_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` inside the Docker image) |
| `LOCALLEAF_PASSWORD` | *(none)* | If set, the whole app requires this password (HTTP Basic auth, any username) |
| `LOCALLEAF_ALLOWED_HOSTS` | *(none)* | Comma-separated host names to serve besides `localhost` (e.g. `latex.example.org`); `*` disables the check |
| `LOCALLEAF_TRUST_PROXY` | *(off)* | Set when behind a reverse proxy (`true`, a hop count, or e.g. `loopback`) so client IPs come from `X-Forwarded-For` |
| `LOCALLEAF_DATA_DIR` | `./data` | Where projects are stored |
| `LOCALLEAF_COMPILER` | `auto` | `auto`, `docker`, `texlive` (TeX Live next to the server, used by the image), `latexmk` or `tectonic` |
| `LOCALLEAF_DOCKER_IMAGE` | `texlive/texlive:latest` | TeX Live image for the Docker backend (e.g. pin `texlive/texlive:TL2025-historic`) |
| `LOCALLEAF_CONTAINER` | `localleaf-texlive` | Name of the helper container (Docker backend) |
| `LOCALLEAF_WORK_DIR` | OS temp dir | Build directory for the `texlive` backend |
| `LOCALLEAF_COMPILE_TIMEOUT` | `300` | Seconds before a compile is killed |
| `LOCALLEAF_MAX_UPLOAD_MB` | `300` | Upload size limit |
| `LOCALLEAF_SKIP_SETUP` | *(unset)* | `1` skips the compiler check / Docker offer that `npm start` runs first |

## Hosting it for others

By default Localleaf only answers on `localhost`. To use it from other machines (a home server or a lab box):

1. Set a password and the address people will use, e.g. in `.env`:
   ```
   LOCALLEAF_PASSWORD=choose-a-long-random-password
   LOCALLEAF_ALLOWED_HOSTS=latex.example.org
   ```
2. In `docker-compose.yml`, change the port mapping from `"127.0.0.1:4000:4000"` to `"4000:4000"`, or keep it
   and put a reverse proxy (Caddy, nginx, Traefik) in front. With a proxy, also set `LOCALLEAF_TRUST_PROXY=true`.
3. **Use HTTPS** (via the reverse proxy) for anything beyond a trusted LAN, because Basic auth sends the password
   with every request.

Everyone with the password shares the same projects. There are no per-user accounts.

## Project layout

```
server/
  security.js           Host allow-list, CSRF header check, optional password
  index.js              entry point (backend detection, static or Vite-dev frontend)
  app.js, http.js       Express app, security middleware, { success, data, error } envelope
  routes/               projects, files, compile/SyncTeX endpoints
  projects/             filesystem project store, zip import/export, blank template
  compiler/             docker + native backends, Docker PATH lookup, re-detection, compile.sh, log parser, SyncTeX parser, compile service
web/src/
  main.js               hash router (#/ and #/project/<id>)
  projectList.js        dashboard
  editor/               workspace, CodeMirror wrapper, completions, file tree, PDF viewer, logs, toolbar
scripts/                setup assistant (npm run setup), CLI zip import
test/                   vitest unit/integration tests; e2e/ drives a real browser
Dockerfile              all-in-one image (Node + TeX Live), used by docker-compose.yml
```

## Testing

```bash
npm test             # unit + API integration tests (no TeX needed; backends are faked)
npm run coverage     # with coverage report
npm run serve & npm run e2e   # end-to-end: real browser (local Chrome/Edge) + real compiler
```

## Security notes

- The server rejects requests whose `Host` header isn't `localhost` or listed in `LOCALLEAF_ALLOWED_HOSTS`
  (DNS-rebinding protection). Every state-changing request needs an `X-Localleaf` header (CSRF protection).
- File paths are normalized and confined to the project folder. Zip imports are checked for zip-slip and
  zip bombs, and `latexmkrc` files in projects are ignored.
- LaTeX runs with restricted `\write18` (no arbitrary shell escape) and can only write inside its build directory.
- **Only compile documents you trust.** LaTeX can *read* any file the compiler can read: other projects, and in
  the all-in-one image the server's environment, including `LOCALLEAF_PASSWORD`. (TeX Live 2026 removed the
  `openin_any` read restriction.) Anyone who can compile already knows the password, but don't compile an untrusted
  `.zip` and then share its PDF. This is the same trust model as Overleaf Community Edition without sandboxed compiles.
- Wrong passwords are throttled per client (10 attempts per 15 minutes, then HTTP 429). There is no per-user
  authorization. Don't expose it to the internet without the password and HTTPS.

## License

[MIT](LICENSE)
