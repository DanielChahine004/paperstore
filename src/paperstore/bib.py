"""A biblatex file read and written without reformatting it.

Each entry keeps its source text, so adding one entry changes only the lines of
that entry and a hand-formatted file round-trips byte for byte.
"""
import re
from dataclasses import dataclass, field


@dataclass
class Entry:
    kind: str          # article, book, ... (lower case)
    key: str
    raw: str           # the entry's source text, @ to closing brace
    fields: dict = field(default_factory=dict)   # name (lower case) -> value, outer braces stripped

    def year(self):
        m = re.search(r"\d{4}", self.fields.get("date") or self.fields.get("year") or "")
        return int(m.group()) if m else None

    @property
    def doi(self):
        d = self.fields.get("doi", "").strip()
        return d.lower() or None


def _close(text, i):
    """Index just past the brace that closes the one at text[i]."""
    depth = 0
    while i < len(text):
        c = text[i]
        if c == "\\":
            i += 2
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    raise ValueError("unbalanced braces")


def _fields(body):
    out, i = {}, 0
    while True:
        m = re.compile(r"\s*,?\s*([A-Za-z][\w.-]*)\s*=\s*").match(body, i)
        if not m:
            return out
        name, i = m.group(1).lower(), m.end()
        if i < len(body) and body[i] == "{":
            j = _close(body, i)
            value = body[i + 1:j - 1]
        elif i < len(body) and body[i] == '"':
            j = body.index('"', i + 1) + 1
            value = body[i + 1:j - 1]
        else:
            j = re.compile(r"[^,}\s]*").match(body, i).end()
            value = body[i:j]
        out[name] = value
        i = j


def parse(text):
    """(preamble, [Entry]) from biblatex source."""
    entries, pos, preamble = [], 0, None
    for m in re.finditer(r"@(\w+)\s*\{", text):
        if m.start() < pos:
            continue
        if preamble is None:
            preamble = text[:m.start()]
        try:
            end = _close(text, m.end() - 1)
        except ValueError:
            line = text.count("\n", 0, m.start()) + 1
            raise ValueError(f"references.bib line {line}: the entry starting here never closes its braces") from None
        raw = text[m.start():end]
        head = re.match(r"@(\w+)\s*\{\s*([^,\s]+)\s*,", raw)
        if head and head.group(1).lower() not in ("comment", "string", "preamble"):
            entries.append(Entry(head.group(1).lower(), head.group(2), raw, _fields(raw[head.end():-1])))
        pos = end
    return preamble or "", entries


def render(preamble, entries):
    return preamble + "\n\n".join(e.raw for e in entries) + "\n"


def insert(entries, entry):
    """Place entry in key order (case ignored), the order the file already keeps."""
    keys = [e.key.lower() for e in entries]
    i = next((n for n, k in enumerate(keys) if k > entry.key.lower()), len(entries))
    return entries[:i] + [entry] + entries[i:]


def plain(text):
    """Lower-case ASCII letters and digits only, for comparing text that differs in markup."""
    import unicodedata
    text = re.sub(r"\$?\\times\$?|×", "x", str(text))
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\\[a-zA-Z]+|\\.", "", text)
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", text.lower())
