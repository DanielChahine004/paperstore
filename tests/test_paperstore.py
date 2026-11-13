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


def test_pdfs_can_live_in_a_folder(store, capsys):
    (store / "pdfs").mkdir()
    (store / "AbiAkl2023.pdf").rename(store / "pdfs" / "AbiAkl2023.pdf")
    bibf = store / "references.bib"
    bibf.write_text(bibf.read_text(encoding="utf-8").replace("{AbiAkl2023.pdf}", "{pdfs/AbiAkl2023.pdf}"), encoding="utf-8")
    cfg = store / "paperstore.toml"
    cfg.write_text((cfg.read_text(encoding="utf-8") if cfg.exists() else "") + '\npdfs = "pdfs"\n', encoding="utf-8")
    with pytest.raises(SystemExit) as ex:
        main(["--store", str(store), "check"])
    assert ex.value.code == 0, capsys.readouterr().out
    # a PDF left beside the bib is now out of place
    (store / "pdfs" / "AbiAkl2023.pdf").rename(store / "AbiAkl2023.pdf")
    bibf.write_text(bibf.read_text(encoding="utf-8").replace("{pdfs/AbiAkl2023.pdf}", "{AbiAkl2023.pdf}"), encoding="utf-8")
    with pytest.raises(SystemExit) as ex:
        main(["--store", str(store), "check"])
    assert ex.value.code == 1
    assert "move it to pdfs/AbiAkl2023.pdf" in capsys.readouterr().out


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


def test_a_box_gets_its_picture(store, capsys):
    def check(*extra):
        with pytest.raises(SystemExit) as ex:
            main(["--store", str(store), "check", *extra])
        return ex.value.code, capsys.readouterr().out
    assert check()[0] == 0
    main(["--store", str(store), "annotate", "AbiAkl2023", "--area", "0.1,0.1,0.5,0.3", "-p", "2", "--by", "test"])
    path = store / "annotations" / "AbiAkl2023.json"
    notes = json.loads(path.read_text())
    ref = f"AbiAkl2023/{notes['annotations'][-1]['id']}"
    code, out = check()
    assert code == 1 and f"figures/{ref}.png is missing" in out
    code, out = check("--fix")
    png = store / "figures" / f"{ref}.png"
    assert code == 0 and png.read_bytes().startswith(b"\x89PNG")
    # the box moves: the picture is out of date until --fix cuts it again
    notes["annotations"][-1]["rects"] = [[0.2, 0.2, 0.6, 0.4]]
    path.write_text(json.dumps(notes))
    assert "out of date" in check()[1]
    assert check("--fix")[0] == 0
    # the box goes: so does its picture
    notes["annotations"].pop()
    path.write_text(json.dumps(notes))
    assert "no such box" in check()[1]
    assert check("--fix")[0] == 0 and not png.exists()


def test_an_ambiguous_quote_is_refused(store):
    with pytest.raises(SystemExit) as ex:
        main(["--store", str(store), "annotate", "AbiAkl2023", "bore diameter of 70 cm"])
    assert "2 matches" in str(ex.value.code)
