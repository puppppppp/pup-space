# Pupae Portfolio

Portfolio site for Kadesiree (Pupae) Panyadee: digital marketing, SEO and graphic design work, 2020–2026.

A single static page, no build step. Open `index.html` in a browser, or serve the folder:

```
npx serve .        # or: python3 -m http.server
```

- `index.html`: page, styles and script (project data lives in the `FOLDERS` array near the bottom)
- `assets/work/`: work samples cropped from the portfolio deck (WebP)
- `assets/Kadesiree_Panyadee_CV.pdf`: CV linked from the page

## Adding performance numbers

Open `index.html` and find `PERFORMANCE DATA`. For each project:

- `value`: the number to show, e.g. `"12,400"` or `"4.8%"` (leave `null` to show "Awaiting data")
- `change`: percent change, e.g. `30` shows +30%
- `months`: monthly organic clicks for the chart, e.g. `[["May",900],["Jun",1100]]`
- `period`: the date range shown at the top right, e.g. `"May – Oct 2026"`

To add a project, drop an image into `assets/work/` and add an entry to the matching folder in `FOLDERS`.

Deploys as-is to GitHub Pages, Netlify or Vercel (set the publish directory to `portfolio/`).
