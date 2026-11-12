# paperstore

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
    paperstore.toml           optional: viewer = "https://you.github.io/paperstore/"

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
([demo, no sign-in](https://danielchahine004.github.io/paperstore/?demo)).
The site is `docs/`, served by GitHub Pages from the main branch. It reads the
store straight from GitHub in your browser: the site itself holds
no papers. Select text and press **Annotate**, or **Box** (key B) to mark a
figure or table; mark notes verified or disputed; copy a link that opens the
paper at that note (`#/Key/id`). Each save is a commit by the person who made it.

Access is whoever can read the repository. Point `docs/config.js` at your
store, then sign in either way:

- **Sign in with GitHub** needs a GitHub App and the small helper in `worker/`
  on Cloudflare Workers (free); [worker/README.md](worker/README.md) has the steps.
- **A token**: a fine-grained token limited to the store, with Contents read and
  write, pasted once per browser.

## Licence

MIT. The demo paper is CC BY 4.0; see `docs/demo/README.md`.
