# Materials — drop your study resources here

Put your *Mariñeiro Pescador* resources in this folder, then tell Claude
"materials are in". Claude reads these files directly (they never go through
the chat), which keeps token cost low.

## How to add files

- **GitHub web:** open this folder → "Add file" → "Upload files" → drag them in → commit.
- **Or push from your computer** into this same `materials/` folder.

## Best order to upload (cheapest + most useful first)

1. **Past exam papers** (real previous tests) — most valuable, lets the app match the real format.
2. **Text-based PDFs** (syllabus, manuals, study guides) — cheap to process.
3. **Photos / scans** — processed with vision (more tokens). Clear, cropped, well-lit
   shots read far cheaper than blurry full-page photos.

## Tips

- Use descriptive filenames (e.g. `temario-seguridade.pdf`, `examen-2023.pdf`).
- Feel free to organise into subfolders by topic — Claude will follow the structure.
- You don't need to upload everything at once; add a batch, say "materials are in",
  and Claude will process them and report roughly how many tokens it used.

Once materials are here, Claude generates `questions.json` (the question bank) and
builds the offline PWA quiz app, deployed to GitHub Pages.
