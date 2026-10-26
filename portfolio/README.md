# Pupae Portfolio

Portfolio site for Kadesiree (Pupae) Panyadee: digital marketing, SEO and graphic design work, 2020–2026.

A single static page, no build step. Open `index.html` in a browser, or serve the folder:

```
npx serve .        # or: python3 -m http.server
```

- `index.html`: page, styles and script (project data lives in the `FOLDERS` array near the bottom)
- `assets/work/`: work samples cropped from the portfolio deck (WebP)
- `assets/Kadesiree_Panyadee_CV.pdf`: CV linked from the page

To add a project, drop an image into `assets/work/` and add an entry to the matching folder in `FOLDERS`.

Deploys as-is to GitHub Pages, Netlify or Vercel (set the publish directory to `portfolio/`).
