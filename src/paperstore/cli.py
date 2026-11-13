"""paperstore: a git folder of papers, checked against their DOIs, with anchored notes.

    paperstore add DOI [--pdf FILE]        fetch the record, make the key and entry, file the PDF
    paperstore fetch [--refresh]           cache the record of every DOI in the bibliography
    paperstore check [--fix] [--live]      everything below holds, or say what does not
    paperstore search REGEX [-k KEY]       which papers and pages say this
    paperstore text KEY [-p PAGE]          a paper's text, page by page
    paperstore info KEY                    its entry, PDF and annotations
    paperstore annotate KEY QUOTE [...]    anchor a quote and attach a note, tags, a value
    paperstore notes [-k KEY] [-t TAG]     list annotations, filtered
    paperstore set KEY ID [...]            change an annotation's status, note or tags
    paperstore annotate KEY --figure N -p PAGE   box the Nth figure on a page instead
    paperstore link KEY [ID]               the viewer URL that opens it

Run inside the store, or pass --store PATH. --json on search, info and notes
prints machine-readable output.

What check holds:
  - every DOI has its record cached, and each key's surname and year match it
  - each entry's title, year, volume, issue and first page agree with the record,
    except fields the entry excuses with `nocheck = {field: reason; ...}`
  - every entry has its PDF, unless it is a book or says `nopdf = {reason}`, and
    every PDF has an entry
  - each PDF carries its entry's DOI or title on its first two pages
  - every annotation names an entry, and every quote is still found on its page
"""
import argparse
import json
import re
import shutil
import sys
from pathlib import Path

from . import bib, pdf, records
from .store import Store, me, new_id, now


def _store(args):
    root = Path(args.store) if args.store else Path.cwd()
    while not (root / "references.bib").exists():
        if root.parent == root:
            sys.exit("not in a paper store: no references.bib here or above (use --store)")
        root = root.parent
    s = Store(root)
    s.load()
    return s


def _excused(e):
    out = {}
    for part in e.fields.get("nocheck", "").split(";"):
        if ":" in part:
            f, why = part.split(":", 1)
            out[f.strip().lower()] = why.strip()
    return out


# ---- add / fetch -----------------------------------------------------------------------------

def cmd_add(s, args):
    doi = re.sub(r"^(https?://(dx\.)?doi\.org/|doi:)", "", args.doi.strip(), flags=re.I)
    recs = s.records()
    if any(e.doi == doi.lower() for e in s.entries):
        sys.exit(f"{doi} is already in references.bib as " + next(e.key for e in s.entries if e.doi == doi.lower()))
    c = recs.get(doi.lower()) or records.fetch(doi)
    recs[doi.lower()] = c
    key = args.key or records.make_key(c, [e.key for e in s.entries])
    e = records.make_entry(key, c, pdf=s.pdf_field(key) if args.pdf else None)
    if args.pdf:
        src = Path(args.pdf)
        if not src.read_bytes().startswith(b"%PDF"):
            sys.exit(f"{src} is not a PDF")
        dest = s.pdf_path(key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)
        problem = pdf.identity_problem(dest, e, s.cache)
        if problem and not args.force:
            dest.unlink()
            sys.exit(problem + "\nnot added; check the file, or pass --force if it is right")
    if args.pdf:
        pdf.thumbnail(dest, s.thumbs / f"{key}.jpg")
    s.entries = bib.insert(s.entries, e)
    s.save()
    s.save_records(recs)
    print(f"added {key}: {c.get('title', '')}" + ("" if args.pdf else "  (no PDF yet: save it as " + s.pdf_field(key) + ")"))
    print(e.raw)


def cmd_fetch(s, args):
    recs, n = s.records(), 0
    for e in s.entries:
        if e.doi and (args.refresh or e.doi not in recs):
            try:
                recs[e.doi] = records.fetch(e.doi)
                n += 1
                print("fetched", e.key, e.doi)
            except Exception as err:  # noqa: BLE001  a dead DOI is reported, not fatal
                print(f"  {e.key}: {e.doi} did not resolve ({err})")
    s.save_records(recs)
    print(f"{n} record(s) fetched")


# ---- check -----------------------------------------------------------------------------------

def _check_bib(s):
    out, recs = [], s.records()
    keys = [e.key.lower() for e in s.entries]
    out += [f"duplicate key {k}" for k in sorted({k for k in keys if keys.count(k) > 1})]
    for e in s.entries:
        if not e.doi:
            continue
        c = recs.get(e.doi)
        if c is None:
            out.append(f"{e.key}: record for {e.doi} not cached (run: paperstore fetch)")
            continue
        excused = _excused(e)
        if "key" not in excused:
            p = records.key_problem(e, c)
            if p:
                out.append(p)
        out += [p for p in records.field_problems(e, c) if p.split(":")[1].split()[0] not in excused]
    return out


def _check_files(s):
    out = []
    named = set()
    for e in s.entries:
        f = s.pdf(e)
        if f is None:
            if e.kind != "book" and "nopdf" not in e.fields:
                out.append(f"{e.key}: no PDF (add file = {{{s.pdf_field(e.key)}}}, or nopdf = {{reason}})")
            continue
        named.add(f.resolve())
        if not f.exists():
            out.append(f"{e.key}: {f.name} is missing")
        elif f.stem != e.key:
            out.append(f"{e.key}: its PDF is {f.name}; name it {e.key}.pdf")
        elif f.parent != s.pdf_dir:
            out.append(f"{e.key}: its PDF is not in the store's PDF folder; move it to {s.pdf_field(e.key)}")
        else:
            p = pdf.identity_problem(f, e, s.cache)
            if p and "identity" not in _excused(e):
                out.append(p)
    out += [f"{p.name}: no entry in references.bib" for p in sorted(s.pdf_dir.glob("*.pdf")) if p.resolve() not in named]
    return out


def _check_thumbs(s, fix):
    out = []
    pdfs = {p.stem: p for p in s.pdf_dir.glob("*.pdf")}
    for key, p in sorted(pdfs.items()):
        t = s.thumbs / f"{key}.jpg"
        if not t.exists():
            if fix:
                pdf.thumbnail(p, t)
                print(f"made thumbs/{key}.jpg")
            else:
                out.append(f"thumbs/{key}.jpg is missing (run: paperstore check --fix)")
    if s.thumbs.exists():
        for t in sorted(s.thumbs.glob("*.jpg")):
            if t.stem not in pdfs:
                if fix:
                    t.unlink()
                else:
                    out.append(f"thumbs/{t.name}: no {t.stem}.pdf (run: paperstore check --fix)")
    return out


def _check_figures(s, fix):
    """figures/<Key>/<id>.png for every box annotation, cut from the box it records
    (figures/index.json holds the page and box each was cut from, so a moved box
    is a stale picture); a picture with no box left is stale too."""
    out = []
    idx_path = s.figures / "index.json"
    index = json.loads(idx_path.read_text(encoding="utf-8")) if idx_path.exists() else {}
    want = {}
    for key, notes in s.all_notes().items():
        for n in notes:
            if n.get("kind") == "area" and n.get("rects") and n.get("page"):
                want[f"{key}/{n['id']}"] = {"page": n["page"], "rect": n["rects"][0]}
    entries = {e.key: e for e in s.entries}
    for ref, box in sorted(want.items()):
        png = s.figures / f"{ref}.png"
        if png.exists() and index.get(ref) == box:
            continue
        key = ref.split("/")[0]
        path = s.pdf(entries[key]) if key in entries else None
        if fix and path and path.exists():
            pdf.crop(path, box["page"], box["rect"], png)
            index[ref] = box
            print(f"made figures/{ref}.png")
        else:
            out.append(f"figures/{ref}.png is {'out of date' if png.exists() else 'missing'} (run: paperstore check --fix)")
    for png in sorted(s.figures.glob("*/*.png")) if s.figures.exists() else []:
        ref = f"{png.parent.name}/{png.stem}"
        if ref not in want:
            if fix:
                png.unlink()
                index.pop(ref, None)
                if not any(png.parent.iterdir()):
                    png.parent.rmdir()
            else:
                out.append(f"figures/{ref}.png: no such box (run: paperstore check --fix)")
    if fix and (index or idx_path.exists()):
        index = {r: b for r, b in index.items() if r in want}
        s.figures.mkdir(exist_ok=True)
        idx_path.write_text(json.dumps(dict(sorted(index.items())), indent=1) + "\n", encoding="utf-8", newline="\n")
    return out


def _anchor(s, key, n):
    """The anchor a note's quote has now: (hit, problem)."""
    path = s.pdf_path(key)
    q = n.get("quote") or {}
    hits = pdf.find(path, q["exact"], n.get("page"), q.get("prefix", ""), q.get("suffix", ""))
    if not hits and (q.get("prefix") or q.get("suffix")):
        hits = pdf.find(path, q["exact"], n.get("page"))
    if not hits:
        return None, f"{key}/{n['id']}: quote not found on page {n.get('page')}: {q['exact'][:60]!r}"
    if len(hits) > 1 and n.get("rects"):        # the occurrence nearest the stored boxes
        y = n["rects"][0][1]
        hits.sort(key=lambda h: abs(h["rects"][0][1] - y))
    return hits[0], None


def _check_notes(s, fix):
    out, keys = [], {e.key for e in s.entries}
    for key, notes in s.all_notes().items():
        if key not in keys:
            out.append(f"annotations/{key}.json: no entry {key}")
            continue
        if not s.pdf_path(key).exists():
            out.append(f"annotations/{key}.json: {key}.pdf is missing")
            continue
        ids = [n.get("id") for n in notes]
        out += [f"{key}: duplicate annotation id {i}" for i in sorted({i for i in ids if ids.count(i) > 1})]
        changed = False
        for n in notes:
            if n.get("kind", "quote") == "area":
                if not n.get("rects") or not 1 <= n.get("page", 0) <= pdf.page_count(s.pdf_path(key)):
                    out.append(f"{key}/{n['id']}: area note needs a page and rects")
                continue
            hit, problem = _anchor(s, key, n)
            if problem:
                out.append(problem)
                continue
            want = {"page": hit["page"], "rects": hit["rects"],
                    "quote": {**n["quote"], "prefix": hit["prefix"], "suffix": hit["suffix"]}}
            if any(n.get(k) != v for k, v in want.items()):
                if fix:
                    n.update(want)
                    changed = True
                elif n.get("page") != hit["page"] or not n.get("rects"):
                    out.append(f"{key}/{n['id']}: anchor out of date (run: paperstore check --fix)")
        if changed:
            s.save_notes(key, notes)
            print(f"re-anchored annotations in {key}")
    return out


def cmd_check(s, args):
    problems = _check_bib(s) + _check_files(s) + _check_thumbs(s, args.fix) + _check_notes(s, args.fix) + _check_figures(s, args.fix)
    if args.live:
        recs = s.records()
        for e in s.entries:
            if e.doi:
                try:
                    if records.fetch(e.doi) != recs.get(e.doi):
                        problems.append(f"{e.key}: the registry record changed; review it, then: paperstore fetch --refresh")
                except Exception as err:  # noqa: BLE001
                    problems.append(f"{e.key}: {e.doi} no longer resolves ({err})")
    n_notes = sum(len(v) for v in s.all_notes().values())
    for p in problems:
        print(p)
    print(f"{len(s.entries)} entries, {len(list(s.pdf_dir.glob('*.pdf')))} PDFs, {n_notes} annotations: "
          + (f"{len(problems)} problem(s)" if problems else "all checks pass"))
    sys.exit(1 if problems else 0)


# ---- reading ---------------------------------------------------------------------------------

def cmd_search(s, args):
    rx = re.compile(args.pattern, 0 if args.case else re.I)
    hits = []
    for e in s.entries:
        if args.key and e.key.lower() != args.key.lower():
            continue
        f = s.pdf(e)
        if not f or not f.exists():
            continue
        for i, text in enumerate(pdf.pages_text(f, s.cache), 1):
            flat = re.sub(r"\s+", " ", text)
            for m in rx.finditer(flat):
                hits.append({"key": e.key, "page": i,
                             "text": flat[max(0, m.start() - args.context):m.end() + args.context]})
    if args.json:
        print(json.dumps(hits, indent=1, ensure_ascii=False))
        return
    for h in hits[:args.limit]:
        print(f"{h['key']} p.{h['page']}: …{h['text']}…")
    print(f"{len(hits)} match(es) in {len({h['key'] for h in hits})} paper(s)"
          + (f"; first {args.limit} shown" if len(hits) > args.limit else ""))


def cmd_text(s, args):
    e = s.entry(args.key)
    pages = pdf.pages_text(s.pdf(e), s.cache)
    for i, t in enumerate(pages, 1):
        if args.page and i != args.page:
            continue
        print(f"=== {e.key} p.{i} ===\n{t}")


def cmd_info(s, args):
    e = s.entry(args.key)
    f = s.pdf(e)
    info = {"key": e.key, "type": e.kind, **{k: v for k, v in e.fields.items() if k != "abstract"},
            "pdf": f.name if f and f.exists() else None,
            "pages": pdf.page_count(f) if f and f.exists() else None,
            "annotations": s.notes(e.key), "link": s.link(e.key)}
    if args.json:
        print(json.dumps(info, indent=1, ensure_ascii=False))
        return
    for k in ("key", "type", "title", "author", "date", "journaltitle", "doi", "pdf", "pages", "link"):
        if info.get(k):
            print(f"{k:>12}: {info[k]}")
    for n in info["annotations"]:
        print(_line(e.key, n))


# ---- annotations -----------------------------------------------------------------------------

def _line(key, n):
    what = (n.get("quote") or {}).get("exact") or "[box" + (": " + n["label"] if n.get("label") else "") + "]"
    tags = " ".join("#" + t for t in n.get("tags", []))
    val = n.get("value")
    val = f" = {val.get('number')} {val.get('unit', '')}".rstrip() if val else ""
    return (f"{key}/{n['id']} p.{n.get('page')} [{n.get('status', 'unchecked')}] {n.get('creator', '')}: "
            f"\"{what[:90]}\"{val} {tags}" + (f"\n      {n['note']}" if n.get("note") else ""))


def cmd_annotate(s, args):
    e = s.entry(args.key)
    path = s.pdf(e)
    if not path or not path.exists():
        sys.exit(f"{e.key} has no PDF to annotate")
    if args.area or args.figure:
        if not args.page:
            sys.exit("a box needs --page")
        if args.figure:
            figs = pdf.figures(path, args.page)
            if not 1 <= args.figure <= len(figs):
                sys.exit(f"page {args.page} has {len(figs)} figure image(s)")
            rect = figs[args.figure - 1]
        else:
            rect = [float(v) for v in args.area.split(",")]
        n = {"id": new_id(), "created": now(), "creator": args.by or me(), "kind": "area", "page": args.page,
             "rects": [rect], "note": args.note or "", "tags": args.tag or [], "status": "unchecked"}
        if args.quote:
            n["label"] = args.quote
        s.save_notes(e.key, s.notes(e.key) + [n])
        print(_line(e.key, n))
        print(s.link(e.key, n["id"]))
        return
    if not args.quote:
        sys.exit("give the quote, or --area/--figure with --page for a box")
    hits = pdf.find(path, args.quote, args.page, args.prefix or "", args.suffix or "")
    if not hits:
        sys.exit(f"not found in {e.key}" + (f" on page {args.page}" if args.page else "")
                 + "; copy the quote exactly, or try: paperstore search")
    if len(hits) > 1 and args.occurrence is None:
        sys.exit(f"{len(hits)} matches, on pages {sorted({h['page'] for h in hits})}: "
                 "lengthen the quote, give --page, or pick one with --occurrence N (1-based)")
    hit = hits[(args.occurrence or 1) - 1]
    n = {"id": new_id(), "created": now(), "creator": args.by or me(), "kind": "quote",
         "page": hit["page"], "quote": {"exact": args.quote, "prefix": hit["prefix"], "suffix": hit["suffix"]},
         "rects": hit["rects"], "note": args.note or "", "tags": args.tag or [], "status": "unchecked"}
    if args.value is not None:
        n["value"] = {"number": args.value, **({"unit": args.unit} if args.unit else {}),
                      **({"what": args.what} if args.what else {})}
    notes = s.notes(e.key) + [n]
    s.save_notes(e.key, notes)
    print(_line(e.key, n))
    print(s.link(e.key, n["id"]))


def cmd_notes(s, args):
    out = []
    for key, notes in s.all_notes().items():
        if args.key and key.lower() != args.key.lower():
            continue
        for n in notes:
            if args.tag and args.tag not in n.get("tags", []):
                continue
            if args.status and n.get("status", "unchecked") != args.status:
                continue
            if args.by and n.get("creator") != args.by:
                continue
            if args.grep and not re.search(args.grep, json.dumps(n, ensure_ascii=False), re.I):
                continue
            out.append({"key": key, **n, "link": s.link(key, n["id"])})
    if args.json:
        print(json.dumps(out, indent=1, ensure_ascii=False))
        return
    for n in out:
        print(_line(n["key"], n))
    print(f"{len(out)} annotation(s)")


def cmd_set(s, args):
    notes = s.notes(args.key)
    n = next((n for n in notes if n["id"] == args.id), None)
    if n is None:
        sys.exit(f"no annotation {args.id} on {args.key}")
    if args.delete:
        notes.remove(n)
        s.save_notes(args.key, notes)
        print(f"deleted {args.key}/{args.id}")
        return
    if args.status:
        n["status"] = args.status
    if args.note is not None:
        n["note"] = args.note
    if args.tag:
        n["tags"] = args.tag
    n["modified"] = now()
    s.save_notes(args.key, notes)
    print(_line(args.key, n))


def cmd_link(s, args):
    print(s.link(s.entry(args.key).key, args.id))


def main(argv=None):
    ap = argparse.ArgumentParser(prog="paperstore", description=__doc__.split("\n")[0])
    ap.add_argument("--store", help="the store folder (default: here or above)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("add", help="add a paper by DOI")
    a.add_argument("doi")
    a.add_argument("--pdf", help="its PDF, copied in as <Key>.pdf")
    a.add_argument("--key", help="override the generated key")
    a.add_argument("--force", action="store_true", help="file the PDF even if its first pages do not show the DOI or title")

    a = sub.add_parser("fetch", help="cache DOI records")
    a.add_argument("--refresh", action="store_true")

    a = sub.add_parser("check", help="check the store")
    a.add_argument("--fix", action="store_true", help="re-anchor annotations whose boxes or context moved; make missing thumbnails")
    a.add_argument("--live", action="store_true", help="also refetch every record and compare")

    a = sub.add_parser("search", help="regex search over every paper's text")
    a.add_argument("pattern")
    a.add_argument("-k", "--key")
    a.add_argument("--case", action="store_true", help="case-sensitive")
    a.add_argument("--context", type=int, default=80)
    a.add_argument("--limit", type=int, default=50)
    a.add_argument("--json", action="store_true")

    a = sub.add_parser("text", help="print a paper's text")
    a.add_argument("key")
    a.add_argument("-p", "--page", type=int)

    a = sub.add_parser("info", help="a paper's entry and annotations")
    a.add_argument("key")
    a.add_argument("--json", action="store_true")

    a = sub.add_parser("annotate", help="anchor a quote and note it")
    a.add_argument("key")
    a.add_argument("quote", nargs="?", help="text exactly as in the paper (spacing, case and line-end hyphens may differ); with a box, its label")
    a.add_argument("--area", help="a box instead of a quote: x0,y0,x1,y1 as page fractions from the top left")
    a.add_argument("--figure", type=int, help="a box around the Nth figure image on --page")
    a.add_argument("-p", "--page", type=int)
    a.add_argument("-n", "--note")
    a.add_argument("-t", "--tag", action="append")
    a.add_argument("--value", type=float, help="the number this quote reports")
    a.add_argument("--unit")
    a.add_argument("--what", help="the quantity, e.g. CTR")
    a.add_argument("--prefix", help="text just before, to pick one of several matches")
    a.add_argument("--suffix", help="text just after")
    a.add_argument("--occurrence", type=int)
    a.add_argument("--by", help="creator (default: git user.name)")

    a = sub.add_parser("notes", help="list annotations")
    a.add_argument("-k", "--key")
    a.add_argument("-t", "--tag")
    a.add_argument("--status", choices=["unchecked", "verified", "disputed"])
    a.add_argument("--by")
    a.add_argument("--grep")
    a.add_argument("--json", action="store_true")

    a = sub.add_parser("set", help="change an annotation")
    a.add_argument("key")
    a.add_argument("id")
    a.add_argument("--status", choices=["unchecked", "verified", "disputed"])
    a.add_argument("-n", "--note")
    a.add_argument("-t", "--tag", action="append")
    a.add_argument("--delete", action="store_true")

    a = sub.add_parser("link", help="viewer URL")
    a.add_argument("key")
    a.add_argument("id", nargs="?")

    args = ap.parse_args(argv)
    s = _store(args)
    globals()["cmd_" + args.cmd](s, args)


if __name__ == "__main__":
    main()
