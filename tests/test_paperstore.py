"""The CLI's contracts, against the demo store (one CC BY paper) and small fixtures."""
import json
import shutil
from pathlib import Path

import pytest

from paperstore import bib, pdf, records
from paperstore.cli import main

DEMO = Path(__file__).resolve().parents[1] / "docs" / "demo"


@pytest.fixture
def store(tmp_path):
    shutil.copytree(DEMO, tmp_path / "s")
    return tmp_path / "s"


def test_bib_round_trips_byte_for_byte():
    text = (DEMO / "references.bib").read_text(encoding="utf-8")
    pre, entries = bib.parse(text)
    assert bib.render(pre, entries) == text
    assert entries[0].key == "AbiAkl2023" and entries[0].doi == "10.1186/s40658-023-00559-2"


def test_quote_anchors_despite_spacing_case_and_dashes():
    hits = pdf.find(DEMO / "AbiAkl2023.pdf", "THE SENSITIVITY of design   A was calculated")
    assert [h["page"] for h in hits] == [1]
    assert all(0 <= v <= 1 for r in hits[0]["rects"] for v in r)


def test_invented_quote_is_not_found():
    assert pdf.find(DEMO / "AbiAkl2023.pdf", "a CTR of 12 ps was measured") == []


def test_key_must_match_the_record():
    _, (e,) = bib.parse((DEMO / "references.bib").read_text(encoding="utf-8"))
    c = json.loads((DEMO / "records.json").read_text())[e.doi]
    assert records.key_problem(e, c) is None
    e.key = "Smith2023"
    assert "first author" in records.key_problem(e, c)


def test_demo_store_checks_clean(store):
    with pytest.raises(SystemExit) as ex:
        main(["--store", str(store), "check"])
    assert ex.value.code == 0


def test_a_moved_quote_fails_check(store):
    notes = json.loads((store / "annotations" / "AbiAkl2023.json").read_text())
    q = next(n for n in notes["annotations"] if n.get("quote"))
    q["quote"]["exact"] = "a sentence this paper never contains"
    (store / "annotations" / "AbiAkl2023.json").write_text(json.dumps(notes))
    with pytest.raises(SystemExit) as ex:
        main(["--store", str(store), "check"])
    assert ex.value.code == 1


def test_annotate_writes_an_anchored_note(store, capsys):
    main(["--store", str(store), "annotate", "AbiAkl2023", "bore diameter of 70 cm", "-p", "4", "--by", "test"])
    notes = json.loads((store / "annotations" / "AbiAkl2023.json").read_text())["annotations"]
    n = notes[-1]
    assert n["page"] == 4 and n["rects"] and n["quote"]["prefix"]


def test_an_ambiguous_quote_is_refused(store):
    with pytest.raises(SystemExit) as ex:
        main(["--store", str(store), "annotate", "AbiAkl2023", "bore diameter of 70 cm"])
    assert "2 matches" in str(ex.value.code)
