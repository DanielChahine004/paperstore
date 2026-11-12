"""A paper store: one folder holding the bibliography, the PDFs and the annotations.

    references.bib            the bibliography; each entry's `file` names its PDF
    <Key>.pdf                 one PDF per entry, named by its key
    records.json              doi.org records for every DOI, the witness the checks use
    annotations/<Key>.json    highlights, notes and cited quotes for one paper
    thumbs/<Key>.jpg          the first page, small, for the viewer's library
    paperstore.toml           optional: viewer URL and the GitHub repo
    .paperstore/              local cache (page text), never committed
"""
import json
import secrets
import subprocess
import tomllib
from datetime import datetime, timezone
from pathlib import Path

from . import bib


class Store:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.bib_path = self.root / "references.bib"
        self.records_path = self.root / "records.json"
        self.notes_dir = self.root / "annotations"
        self.cache = self.root / ".paperstore"
        self.thumbs = self.root / "thumbs"
        cfg = self.root / "paperstore.toml"
        self.config = tomllib.loads(cfg.read_text()) if cfg.exists() else {}

    # -- bibliography
    def load(self):
        self.preamble, self.entries = bib.parse(self.bib_path.read_text(encoding="utf-8"))
        return self.entries

    def save(self):
        self.bib_path.write_text(bib.render(self.preamble, self.entries), encoding="utf-8", newline="\n")

    def entry(self, key):
        for e in self.entries:
            if e.key.lower() == key.lower():
                return e
        raise SystemExit(f"no entry {key} in references.bib")

    def pdf(self, e):
        f = e.fields.get("file")
        return self.root / f if f else None

    # -- records
    def records(self):
        return json.loads(self.records_path.read_text()) if self.records_path.exists() else {}

    def save_records(self, recs):
        self.records_path.write_text(json.dumps(dict(sorted(recs.items())), indent=1, ensure_ascii=False) + "\n")

    # -- annotations
    def notes_path(self, key):
        return self.notes_dir / f"{key}.json"

    def notes(self, key):
        p = self.notes_path(key)
        return json.loads(p.read_text(encoding="utf-8"))["annotations"] if p.exists() else []

    def save_notes(self, key, notes):
        self.notes_dir.mkdir(exist_ok=True)
        data = {"paper": key, "annotations": notes}
        self.notes_path(key).write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")

    def all_notes(self):
        return {p.stem: json.loads(p.read_text(encoding="utf-8"))["annotations"]
                for p in sorted(self.notes_dir.glob("*.json"))} if self.notes_dir.exists() else {}

    # -- links
    def link(self, key, note_id=None):
        base = self.config.get("viewer", "").rstrip("/")
        frag = f"#/{key}" + (f"/{note_id}" if note_id else "")
        return (base + "/" + frag) if base else f"{key}.pdf" + (f" ({note_id})" if note_id else "")


def new_id():
    return secrets.token_hex(3)


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def me():
    try:
        return subprocess.run(["git", "config", "user.name"], capture_output=True, text=True).stdout.strip() or "unknown"
    except OSError:
        return "unknown"
