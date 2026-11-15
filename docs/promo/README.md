# Promo trailer

`promo.html` is the 20-second README trailer: one self-contained page whose
animation is a pure function of time (`window.seek(seconds)`). Open it in a
browser to preview in real time, or add `?t=11.3` (or `?t=poster`) for a still.
All artwork is drawn in the page; nothing is fetched.

To regenerate `docs/media/homeflix-promo.gif` and `homeflix-promo-poster.png`
you need Google Chrome, ffmpeg, and puppeteer-core installed in a scratch
directory outside this repo (the project itself stays dependency-free):

    mkdir -p ~/promo-tools && (cd ~/promo-tools && npm init -y && npm i puppeteer-core)
    PROMO_TOOLS=~/promo-tools node docs/promo/render.mjs

Options: `FPS` (default 20), `CHROME`, `FFMPEG`, `FRAMES_DIR` (keep the PNG
frames), `--frames` (render frames and poster only, skip the GIF).
