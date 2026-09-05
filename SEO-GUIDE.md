# Google Indexing Guide — OKV Church Management System

This covers getting your marketing pages (`index.html`, `pricing.html`, `demo.html`,
`signup.html`, `install.html`, and the legal pages) found and indexed by Google.
`app.html` and `reset-password.html` are deliberately **excluded** — they're private,
behind login/tokens, and shouldn't show up in search results.

## 1. Replace the placeholder domain

Two files, plus a tag on every page, use a placeholder domain that must match exactly
where you actually deploy this (your own domain, a GitHub Pages URL, Netlify, etc.):

- `robots.txt` — the `Sitemap:` line
- `sitemap.xml` — every `<loc>` entry
- Every `.html` page — the `<link rel="canonical" href="...">` tag in `<head>`

Find-and-replace `YOUR-DOMAIN-HERE.com` with your real domain across all of these
(a code editor's "Find in Files" or a command like
`grep -rl "YOUR-DOMAIN-HERE.com" . | xargs sed -i 's/YOUR-DOMAIN-HERE.com/yourrealdomain.com/g'`
on Mac/Linux does it in one pass). Keep `https://` and make sure it's the same host
you deploy `robots.txt` and `sitemap.xml` to — Google ignores a sitemap that lists a
different domain than the one it was fetched from.

## 2. Deploy the files

`robots.txt` and `sitemap.xml` must sit at the **root** of your domain — e.g.
`https://yourrealdomain.com/robots.txt`, not inside a subfolder — or Google won't find
them automatically. If you deploy this app inside a subfolder (e.g.
`yourrealdomain.com/church-app/`), move just these two files to the actual site root,
keeping the paths inside `sitemap.xml` pointed at the subfolder
(e.g. `https://yourrealdomain.com/church-app/index.html`).

## 3. Verify ownership in Google Search Console

1. Go to [Google Search Console](https://search.google.com/search-console) and sign in.
2. Add a property for your domain (the "Domain" property type covers all subdomains
   and is easiest if your host lets you add a DNS TXT record; otherwise use the
   "URL prefix" type and verify with the HTML file or meta-tag method your host
   supports).
3. Once verified, open **Sitemaps** in the left menu, enter `sitemap.xml`, and submit.
4. Open **URL Inspection**, paste your homepage URL, and click **Request Indexing** to
   nudge Google to crawl it right away instead of waiting.

## 4. Confirm the basics are live

Once deployed, double-check in a browser:

- `https://yourrealdomain.com/robots.txt` loads and shows the `Sitemap:` line with
  your real domain.
- `https://yourrealdomain.com/sitemap.xml` loads and lists your real domain on every
  `<loc>` line.
- View source on `index.html` and confirm the `<title>`, `<meta name="description">`,
  and `<link rel="canonical">` tags show your real domain, not the placeholder.

## 5. What's already in place

Every public page already ships with a descriptive `<title>`, a
`<meta name="description">`, a `<link rel="canonical">`, and a `<meta name="robots">`
tag (`index, follow` for marketing pages; `noindex, nofollow` for `app.html` and
`reset-password.html`). You don't need to add these by hand — just fix the domain as
in step 1.

## 6. Ongoing

- Re-submit the sitemap in Search Console any time you add a new public page — add its
  `<url>` entry to `sitemap.xml` first.
- Search Console's **Performance** and **Coverage** reports (left menu) show what's
  indexed and what people search to find you — check back after a week or two.
- If you ever rename or remove a public page, update `sitemap.xml` and consider a
  redirect from the old URL so you don't lose any ranking it built up.
