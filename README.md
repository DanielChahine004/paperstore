# paperstore

**▶ [Open the viewer](https://danielchahine004.github.io/paperstore/)** · [demo, no sign-in](https://danielchahine004.github.io/paperstore/?demo) · [use it for your own papers](#your-own-store)

Your papers as a git repository: the PDFs, the bibliography, and notes anchored
to the exact words or box on the page they came from. A command-line tool
checks every entry against its DOI and every quote against its PDF, and a web
viewer opens it all from any device, with "Sign in with GitHub".

Built so that a person and a coding agent can work from the same library: an
annotation is a JSON file the agent can write, and its quote has to be found on
its page for the store to pass `check`, so a number cited from a paper can be
traced to the place that says it.

## The store

Any git repository (private, if the PDFs are under copyright) laid out as:

    references.bib            biblatex; each entry's `file` names its PDF
    <Key>.pdf                 one per entry, named by its key
    records.json              the doi.org record of every DOI, cached
    annotations/<Key>.json    quotes, boxes, notes, tags, values, status
    paperstore.toml           optional: viewer = "https://you.github.io/paperstore/",
                              and pdfs = "pdfs" to keep the PDFs in pdfs/<Key>.pdf

## The tool

    uv tool install git+https://github.com/DanielChahine004/paperstore
    cd my-papers

    paperstore add 10.1088/1361-6560/ac72f2 --pdf ~/Downloads/paper.pdf
    paperstore check                    # entries, PDFs and quotes all hold
    paperstore search "CTR of [0-9]+ ps"
    paperstore annotate Carra2022 "a CTR of 214 ps" --value 214 --unit ps -t timing -n "why it matters"
    paperstore notes -t timing --json   # for scripts and agents

`add` fetches the DOI's record, makes an `AuthorYear` key and a biblatex entry,
and refuses a PDF whose first pages show neither that DOI nor that title.
`check` holds that each key's surname and year, and each entry's title, year,
volume and first page, agree with the record (an entry can excuse a field with
`nocheck = {field: reason}`); that every entry has its PDF (books and
`nopdf = {reason}` excepted); and that every quote is still on its page.
`check --fix` re-anchors notes whose boxes moved. `paperstore --help` has the rest.

Quotes match with case, spacing, line-end hyphens, ligatures and dash variants
ignored. A quote found more than once is refused until it is longer, or given
`--page` or `--occurrence`. Text in an image cannot be matched: box it with
`--figure N -p PAGE` or `--area x0,y0,x1,y1`, or draw the box in the viewer.

## The viewer

[danielchahine004.github.io/paperstore](https://danielchahine004.github.io/paperstore/)
([demo, no sign-in](https://danielchahine004.github.io/paperstore/?demo)) is
`docs/`, served by GitHub Pages. It reads the store straight from GitHub in the
browser, so the site holds no papers, and it works on a phone.

- **Library:** first-page previews (from `thumbs/`, made by `check --fix`),
  search across titles, authors, keys and venues, filters by year and venue.
- **Claims:** every annotation in the store, searchable and filtered by tag,
  status or person; "Numbers only" turns them into a sortable table of the
  values papers report.
- **Reader:** select text and press **Claim**, or **Box** (key B) to mark a
  figure or table; mark claims verified or disputed; find in the paper; copy a
  link that opens the paper at a claim (`#/Key/id`). Each save is a commit by
  the person who made it.

## Your own store

Anyone can use the same viewer for their own papers:

1. Make a private repository laid out as above (`paperstore add` builds it).
2. Install the [paperstore GitHub App](https://github.com/apps/paperstore-daniel)
   on that repository only.
3. Open the viewer with `?repo=you/your-papers` once (it is remembered), or type
   the repository on the sign-in page, and sign in with GitHub.

Access is whoever can read the repository: add collaborators on GitHub. To run
your own copy instead, fork this repository, point `docs/config.js` at your
store, and either ask to have your copy's address approved for this sign-in
(it is one setting; see [worker/README.md](worker/README.md)), set up your own,
or leave `auth` empty and paste a fine-grained token. Features useful to
everyone are welcome back as pull requests.

## Licence

MIT. The demo paper is CC BY 4.0; see `docs/demo/README.md`.

## Tests

```
uv run --with pytest pytest tests/test_paperstore.py            # the CLI
uv run --with pytest --with playwright pytest tests/test_viewer.py   # the viewer, in headless Chromium
```

The viewer tests run against `tests/fake_github.py`, a local stand-in for GitHub's contents
API. It needs no sign-in and caches the way a phone browser did. For the first run, install
Chromium with `uv run --with playwright playwright install chromium`. To click around by hand,
run `uv run python tests/fake_github.py` and set `localStorage["ps.token"]` to any value.
