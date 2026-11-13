"""DOI records: fetched once from doi.org, cached, and used to check the bibliography.

The bibliography is written by people and tools; the registry record is the
witness. A key's surname and year, and an entry's title, year, volume and first
page, must agree with the record its DOI resolves to, so a DOI that resolves to
a different paper, or a field mistyped by hand, fails offline.
"""
import json
import re
import unicodedata
import urllib.request

from .bib import Entry, plain

KEEP = ("type", "title", "container-title", "volume", "issue", "page", "article-number", "issued",
        "published-print", "published-online", "author", "publisher", "ISSN", "ISBN", "DOI", "URL")


def fetch(doi):
    req = urllib.request.Request(f"https://doi.org/{doi}", headers={
        "Accept": "application/vnd.citationstyles.csl+json", "User-Agent": "paperstore/0.1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        c = json.loads(r.read())
    return {k: c[k] for k in KEEP if k in c}


def years(c):
    """Every year the record gives: issued, print and online can differ by one."""
    out = []
    for f in ("issued", "published-print", "published-online"):
        parts = (c.get(f) or {}).get("date-parts") or [[None]]
        if parts[0] and parts[0][0]:
            out.append(int(parts[0][0]))
    return out


def surname(a):
    if a.get("literal") or a.get("name"):
        return (a.get("literal") or a["name"]).split()[0]
    if not a.get("given"):
        return a.get("family", "").split()[-1] if a.get("family") else ""
    return a.get("family", "")


def first_surnames(c):
    """The surnames a key may start with: the first author's, and where that is a
    collaboration, the first person's."""
    authors = c.get("author") or [{}]
    out = [surname(authors[0])]
    if authors[0].get("literal") or authors[0].get("name"):
        out += [surname(a) for a in authors[1:] if a.get("family")][:1]
    return out


def key_problem(e: Entry, c):
    prefix = plain(re.match(r"[^0-9]*", e.key).group())
    ok = any(s and (prefix.startswith(s) or (s.startswith(prefix) and len(prefix) >= 3))
             for s in map(plain, first_surnames(c)))
    if not ok:
        return f"key {e.key}: the first author of {e.doi} is {first_surnames(c)[0]!r}"
    if not any(str(y) in e.key for y in years(c)):
        return f"key {e.key}: {e.doi} is from {'/'.join(map(str, sorted(set(years(c)))))}"
    return None


def field_problems(e: Entry, c):
    """Fields that disagree with the record: a title with other words, another year,
    volume, issue or first page."""
    out = []
    if c.get("title") and plain(e.fields.get("title", "")) != plain(c["title"]):
        out.append(f"{e.key}: title differs from the record's {c['title']!r}")
    ys = years(c)
    if ys and e.year() and e.year() not in ys:
        out.append(f"{e.key}: year {e.year()} but the record gives {'/'.join(map(str, sorted(set(ys))))}")
    first = lambda v: re.split(r"[^0-9A-Za-z]+", str(v).strip())[0]  # noqa: E731
    for f, have, same in (("volume", c.get("volume"), lambda a, b: plain(a) == plain(b)),
                          ("number", c.get("issue"), lambda a, b: plain(a) == plain(b)),
                          ("pages", c.get("page") or c.get("article-number"), lambda a, b: first(a) == first(b))):
        if e.fields.get(f) and have and not same(e.fields[f], have):
            out.append(f"{e.key}: {f} {e.fields[f]!r} but the record gives {have!r}")
    return out


# ---- making an entry from a record -------------------------------------------------------------

def _ascii(s):
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()


def make_key(c, taken):
    """AuthorYear, the convention of the existing keys: the first author's surname with
    spaces, hyphens and accents dropped, then the year, then a, b, ... if taken."""
    name = re.sub(r"[^A-Za-z]", "", _ascii(first_surnames(c)[0])) or "Anon"
    name = name[0].upper() + name[1:]
    y = (years(c) or [0])[0]
    base = f"{name}{y}"
    taken = {k.lower() for k in taken}
    if base.lower() not in taken:
        return base
    for s in "abcdefghijklmnopqrstuvwxyz":
        if (base + s).lower() not in taken:
            return base + s
    raise ValueError("no free key for " + base)


def _tex(s):
    s = re.sub(r"<[^>]+>", "", str(s))
    s = s.replace("–", "--").replace("—", "---").replace(" ", " ")
    return re.sub(r"(?<!\\)([&%#_])", r"\\\1", s)


def _protect(title):
    """Brace words whose capitals must survive a sentence-case style: acronyms, CamelCase."""
    return re.sub(r"\b([A-Za-z]*[A-Z][A-Za-z]*[A-Z0-9][\w-]*|[A-Z][a-z]*\d[\w-]*)\b", r"{{\1}}", title)


def _name(a):
    if a.get("literal") or a.get("name"):
        return "{" + _tex(a.get("literal") or a["name"]) + "}"
    if a.get("given"):
        return f"{_tex(a['family'])}, {_tex(a['given'])}"
    return _tex(a.get("family", ""))


def make_entry(key, c, pdf=None):
    kind = c.get("type")
    bibtype = {"journal-article": "article", "proceedings-article": "inproceedings",
               "paper-conference": "inproceedings", "book": "book", "book-chapter": "incollection",
               "report": "report", "dissertation": "thesis", "posted-content": "online"}.get(kind, "misc")
    f = {"title": _protect(_tex(c.get("title", ""))),
         "author": " and ".join(_name(a) for a in c.get("author", [])),
         "date": str((years(c) or [""])[0])}
    if c.get("container-title"):
        f["journaltitle" if bibtype == "article" else "booktitle"] = _tex(c["container-title"])
    for name, k in (("volume", "volume"), ("number", "issue")):
        if c.get(k):
            f[name] = _tex(c[k])
    if c.get("page") or c.get("article-number"):
        f["pages"] = _tex(c.get("page") or c["article-number"]).replace("-", "--").replace("----", "--")
    if c.get("publisher"):
        f["publisher"] = _tex(c["publisher"])
    if c.get("ISSN"):
        f["issn"] = c["ISSN"][0] if isinstance(c["ISSN"], list) else c["ISSN"]
    f["doi"] = c.get("DOI", "")
    f["url"] = "https://doi.org/" + c.get("DOI", "")
    if pdf:                                      # the `file` field: the PDF's path in the store
        f["file"] = key + ".pdf" if pdf is True else pdf
    body = ",\n".join(f"  {n} = {{{v}}}" for n, v in f.items() if v)
    raw = f"@{bibtype}{{{key},\n{body}\n}}"
    return Entry(bibtype, key, raw, f)
