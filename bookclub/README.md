# Book Club Picks

A static one-page site for browsing book-club nominations. All card content
lives in `books.md`, so you can edit the page without touching any HTML.

## Editing the content

Open `books.md` and edit the text. The top of the file has page-header
settings (`eyebrow`, `title`, `intro`, `footer`), then one `## Book Title`
section per card:

```markdown
## The Covenant of Water
- author: Abraham Verghese
- accent: #8a4b36
- cover: https://covers.openlibrary.org/isbn/9780802162175-L.jpg
- tags: Literary, Family saga, India, Historical
- sell: A sweeping, emotionally direct multi-generation novel...
- angle: What do families inherit besides property, names, and stories?
- caveat: It is the longest and most traditional pick.
- why: It gives the group an expansive, character-rich novel...
- link: NYT review | https://www.nytimes.com/...
- link: Washington Post | https://www.washingtonpost.com/...
```

- **Add a book**: copy a `## ...` block and edit it. **Remove one**: delete its block.
- **`tags`**: comma-separated, as many as you like.
- **`link`**: one line per link, format `Label | URL`. Add or remove freely.
- Any field you leave out is simply skipped (drop `caveat` and the card omits it).

`index.html` fetches and renders `books.md` at runtime; you should not need to
edit it.

## Local preview

Because the page fetches `books.md`, you need to serve the folder over HTTP
(opening `index.html` directly via `file://` is blocked by the browser):

```bash
python3 -m http.server 8000
```

Then visit http://localhost:8000.

## Deploy with GitHub Pages

This repo is published with GitHub Pages. To set it up on a fresh repo:

1. Push `index.html`, `books.md`, and this `README.md`.
2. In GitHub, go to **Settings → Pages**.
3. Set **Source** to **Deploy from a branch**.
4. Select `main` and `/root`.

Pushing to `main` republishes the site.
