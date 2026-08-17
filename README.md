# dorehmi.com web game

Static website version of Sing the Note. It uses the browser Web Audio API; no backend or third-party JavaScript is required.

## Test locally

```bash
cd ~/sing-the-note/web
python3 -m http.server 8000
```

Open `http://localhost:8000`. Browsers permit microphone access on localhost.

## Deploy

Upload `index.html`, `styles.css`, and `game.js` to any static host. In production the site **must use HTTPS** for browser microphone access. Good options include Cloudflare Pages, Vercel, Netlify, GitHub Pages, or standard web hosting with TLS enabled.

Point both `dorehmi.com` and `www.dorehmi.com` to the chosen host, and redirect one hostname to the other.
