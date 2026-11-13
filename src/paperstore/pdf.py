"""PDF text: extraction, search, the identity check, and anchoring a quote to its boxes.

A quote is matched with case, spacing, line-end hyphens, ligatures and dash
variants ignored, since those are what differ between a PDF's text layer and
a quote copied or typed from it. Boxes are fractions of the page (0..1 from the
top left), so the viewer can draw them at any zoom without knowing the
PDF's coordinate system.
"""
import hashlib
import json
import re
import unicodedata

import pymupdf

DASHES = dict.fromkeys(map(ord, "‐‑‒–—−­"), "-")
QUOTES = dict.fromkeys(map(ord, "‘’‚′"), "'") | dict.fromkeys(map(ord, "“”„″"), '"')


def norm(s):
    """Text as matched: compatibility forms (ligatures, superscripts) folded, dashes and
    quotes unified, lower case, no whitespace."""
    s = unicodedata.normalize("NFKC", s).translate(DASHES).translate(QUOTES).lower()
    s = re.sub(r"-\s*\n\s*", "", s)          # a hyphen that ended a line in a copied quote
    return re.sub(r"\s+", "", s)


def sha(path):
    return hashlib.sha1(path.read_bytes()).hexdigest()


def pages_text(path, cache_dir):
    """[page text], cached by the file's hash so search stays fast."""
    cache = cache_dir / "text" / (path.stem + ".json")
    digest = sha(path)
    if cache.exists():
        data = json.loads(cache.read_text(encoding="utf-8"))
        if data.get("sha") == digest:
            return data["pages"]
    with pymupdf.open(path) as doc:
        pages = [p.get_text() for p in doc]
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps({"sha": digest, "pages": pages}), encoding="utf-8")
    return pages


def identity_problem(path, entry, cache_dir):
    """Why this PDF may not be the entry's paper, or None: its first two pages must carry
    the DOI or the start of the title."""
    pages = pages_text(path, cache_dir)
    if not pages:
        return f"{path.name}: no pages"
    head = "\n".join(pages[:2])
    if not head.strip():
        return f"{path.name}: no text layer on its first pages (a scan?); cannot check it is {entry.key}"
    if entry.doi and norm(entry.doi) in norm(head):
        return None
    from .bib import plain
    title = plain(entry.fields.get("title", ""))[:40]
    if title and title in plain(head):
        return None
    return f"{path.name}: neither the DOI nor the title of {entry.key} is on its first two pages"


# ---- anchoring -------------------------------------------------------------------------------

def _stream(page):
    """The page's words as one normalised string, and for each of its characters the
    index of the word it came from."""
    words = page.get_text("words")
    chars, owner = [], []
    for i, w in enumerate(words):
        t = w[4]
        nxt = words[i + 1] if i + 1 < len(words) else None
        line_end = nxt is None or (nxt[5], nxt[6]) != (w[5], w[6])
        if line_end and t.translate(DASHES).endswith("-") and nxt and nxt[4][:1].islower():
            t = t[:-1]                          # detec- / tor reads as detector
        n = norm(t)
        chars.append(n)
        owner += [i] * len(n)
    return words, "".join(chars), owner


def _boxes(page, words, idx):
    """One box per line spanned by the words idx, as page fractions."""
    W, H = page.rect.width, page.rect.height
    lines = {}
    for i in idx:
        x0, y0, x1, y1, _, b, l, _ = words[i]
        r = lines.setdefault((b, l), [x0, y0, x1, y1])
        r[:] = [min(r[0], x0), min(r[1], y0), max(r[2], x1), max(r[3], y1)]
    return [[round(r[0] / W, 4), round(r[1] / H, 4), round(r[2] / W, 4), round(r[3] / H, 4)]
            for r in lines.values()]


def _context(words, idx, before):
    """About eight words either side of a match, for the prefix and suffix selectors."""
    if before:
        return " ".join(w[4] for w in words[max(0, idx[0] - 8):idx[0]])
    return " ".join(w[4] for w in words[idx[-1] + 1:idx[-1] + 9])


def find(path, quote, page=None, prefix="", suffix=""):
    """Every place quote occurs: [{page (1-based), rects, prefix, suffix}]. With prefix or
    suffix given, only the occurrences whose surroundings fit them."""
    q = norm(quote)
    if len(q) < 3:
        raise ValueError("quote too short to anchor")
    hits = []
    with pymupdf.open(path) as doc:
        for pno in ([page - 1] if page else range(doc.page_count)):
            if not 0 <= pno < doc.page_count:
                raise ValueError(f"{path.stem} has {doc.page_count} pages, not {page}")
            p = doc[pno]
            words, s, owner = _stream(p)
            for m in re.finditer(re.escape(q), s):
                idx = sorted(set(owner[m.start():m.end()]))
                pre, suf = _context(words, idx, True), _context(words, idx, False)
                if prefix and not norm(pre).endswith(norm(prefix)[-20:]):
                    continue
                if suffix and not norm(suf).startswith(norm(suffix)[:20]):
                    continue
                hits.append({"page": pno + 1, "rects": _boxes(p, words, idx), "prefix": pre, "suffix": suf})
    return hits


def figures(path, page):
    """The image boxes on a page, as page fractions: where the figures are, for boxing one."""
    with pymupdf.open(path) as doc:
        p = doc[page - 1]
        W, H = p.rect.width, p.rect.height
        out = []
        for img in p.get_images(full=True):
            for r in p.get_image_rects(img[0]):
                if r.width * r.height > 0.01 * W * H:
                    out.append([round(r.x0 / W, 4), round(r.y0 / H, 4), round(r.x1 / W, 4), round(r.y1 / H, 4)])
        return out


def crop(path, page, rect, out, dpi=200):
    """A box (page fractions) as a PNG: the picture a box annotation marks."""
    with pymupdf.open(path) as doc:
        p = doc[page - 1]
        W, H = p.rect.width, p.rect.height
        x0, y0, x1, y1 = rect
        pix = p.get_pixmap(clip=pymupdf.Rect(x0 * W, y0 * H, x1 * W, y1 * H), dpi=dpi)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(pix.tobytes("png"))


def thumbnail(path, out, width=240):
    """The first page as a small JPEG, for the viewer's library."""
    with pymupdf.open(path) as doc:
        p = doc[0]
        pix = p.get_pixmap(matrix=pymupdf.Matrix(width / p.rect.width, width / p.rect.width))
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(pix.tobytes("jpeg", jpg_quality=70))


def page_count(path):
    with pymupdf.open(path) as doc:
        return doc.page_count
