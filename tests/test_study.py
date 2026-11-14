"""The viewer's study mode (?study=owner/repo) against tests/fake_github.py: a study repository
with report/sources-paper.json on main and the draft PDF on its drafts branch.

    uv run --with pytest --with playwright pytest tests/test_study.py
"""
import json
import shutil
from pathlib import Path

import pymupdf as fitz
import pytest

pw = pytest.importorskip("playwright.sync_api")

from fake_github import FakeGitHub  # noqa: E402

DEMO = Path(__file__).resolve().parents[1] / "docs" / "demo"
STUDY = "test/study"
SHEET = "https://github.com/test/study/blob/main/report/sources-paper.md"
VIEWER = "https://example.github.io/paperstore/"
FACTS = '''from step3_outputs.sources import Facts
F = Facts()
@F
def sensitivity():
    r = load("run.json")
    return {"design A sensitivity": num(r["a"])}


@F
def other():
    return {}
'''


def sources():
    return {
        "paper": "paper", "repo": "https://github.com/test/study", "draft": "paper/draft.pdf",
        "facts": {
            "design A sensitivity": {"value": "29.2", "slug": "design-a-sensitivity",
                                     "code": {"path": "step3_outputs/facts.py", "line": 3, "commit": "abc1234"},
                                     "reads": [{"path": "results/run.json", "line": None, "commit": "abc1234"}],
                                     "used": ["paper/main.tex:12"]},
        },
        "claims": [
            {"file": "paper/main.tex", "line": 20, "star": False, "refs": ["AbiAkl2023/25e2c6"], "said": [29.2],
             "sentence": "Design A reaches \\fact{design A sensitivity}\\,kcps/MBq \\claim{AbiAkl2023/25e2c6}."},
            {"file": "paper/main.tex", "line": 24, "star": False, "refs": ["AbiAkl2023/4dd4a4"], "said": [99.0],
             "sentence": "Design B reaches 99\\,kcps/MBq \\claim{AbiAkl2023/4dd4a4}."},
        ],
        "unsourced": [{"file": "paper/main.tex", "line": 30, "sentence": "The slab is 15\\,mm thick."}],
        "problems": [],
    }


def draft(path):
    """A two-line draft whose numbers link as the study template's draft build links them."""
    doc = fitz.open()
    page = doc.new_page(width=400, height=300)
    page.insert_text((40, 60), "Design A reaches 29.2 kcps/MBq >", fontsize=14)
    page.insert_text((40, 120), "Design B reaches 99 kcps/MBq >", fontsize=14)
    page.insert_link({"kind": fitz.LINK_URI, "from": fitz.Rect(160, 46, 196, 64), "uri": SHEET + "#design-a-sensitivity"})
    page.insert_link({"kind": fitz.LINK_URI, "from": fitz.Rect(268, 46, 280, 64), "uri": VIEWER + "#/AbiAkl2023/25e2c6"})
    page.insert_link({"kind": fitz.LINK_URI, "from": fitz.Rect(250, 106, 262, 124), "uri": VIEWER + "#/AbiAkl2023/4dd4a4"})
    path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(path)


@pytest.fixture
def gh(tmp_path):
    shutil.copytree(DEMO, tmp_path / "store")
    main, drafts = tmp_path / "main", tmp_path / "drafts"
    (main / "report").mkdir(parents=True)
    (main / "report" / "sources-paper.json").write_text(json.dumps(sources()))
    (main / "step3_outputs").mkdir()
    (main / "step3_outputs" / "facts.py").write_text(FACTS)
    (main / "results").mkdir()
    (main / "results" / "run.json").write_text('{"a": 29.2, "b": 106.8}')
    draft(drafts / "paper" / "draft.pdf")
    g = FakeGitHub(tmp_path / "store")
    g.repos[STUDY] = {"main": main, "drafts": drafts}
    g.start()
    yield g
    g.stop()


@pytest.fixture
def page(gh):
    with pw.sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1280, "height": 900})
        ctx.add_init_script("localStorage.setItem('ps.token', 'fake')")
        pg = ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.errors = errors
        yield pg
        browser.close()


def test_a_fact_opens_its_code_and_files(page, gh):
    page.goto(f"{gh.url}?study={STUDY}#/")
    link = page.locator(".srclink.k-fact")
    link.wait_for(timeout=30000)
    link.click()
    card = page.locator("#panel .src.fact.sel")
    assert "design A sensitivity" in card.inner_text() and "29.2" in card.inner_text()
    code = card.locator("pre.peek").first
    page.wait_for_function("() => document.querySelector('#panel pre.peek')?.textContent.includes('def sensitivity')", timeout=10000)
    assert "def other" not in code.inner_text(), "the function, not the rest of the file"
    assert any(r == (STUDY, "abc1234", "step3_outputs/facts.py") for r in gh.reads), "read at the commit that made the number"
    card.get_by_role("button", name="show").click()
    page.wait_for_function("() => [...document.querySelectorAll('#panel pre.peek')].some(p => p.textContent.includes('106.8'))", timeout=10000)
    assert "#/fact/design%20A%20sensitivity" in page.url
    assert not page.errors


def test_claims_are_checked_against_the_store_as_it_is(page, gh):
    page.goto(f"{gh.url}?study={STUDY}#/")
    page.locator(".srclink.k-claim").first.wait_for(timeout=30000)
    assert page.locator(".srclink.k-claim.verified").count() == 1
    assert page.locator(".srclink.k-claim.bad").count() == 1, "99 in the sentence, 106.8 in the paper"
    assert page.locator(".srchl.verified").count() == 1 and page.locator(".srchl.bad").count() == 1, "each claimed sentence highlighted in the text"
    box = page.locator(".srchl.verified").bounding_box()
    assert box["width"] > 150, "the whole sentence, not just the mark"
    page.locator(".srclink.k-claim.verified").click()
    card = page.locator("#panel .src.claimuse.sel")
    assert "The sensitivity of design A" in card.inner_text()
    assert "as the paper does" in card.inner_text()
    page.locator("#panel .ptab", has_text="Checks").click()
    checks = page.locator("#panel .checks").inner_text()
    assert "1 problem" in checks and "the paper says 106.8" in checks
    assert "The slab is 15 mm thick." in checks
    assert not page.errors


def test_open_a_claimed_passage_and_come_back(page, gh):
    page.goto(f"{gh.url}?study={STUDY}#/claim/AbiAkl2023/25e2c6")
    card = page.locator("#panel .src.claimuse.sel")
    card.wait_for(timeout=30000)
    card.locator("a", has_text="open").click()
    page.locator(".hl.sel").first.wait_for(timeout=30000)   # the paper, at the passage
    page.get_by_role("button", name="Back to the manuscript").click()
    page.locator(".srclink.k-fact").wait_for(timeout=10000)
    assert page.locator("#bar .tab.on").inner_text() == "Manuscript"
    assert not page.errors


def test_fits_a_phone(gh):
    with pw.sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 375, "height": 812})
        ctx.add_init_script("localStorage.setItem('ps.token', 'fake')")
        pg = ctx.new_page()
        pg.goto(f"{gh.url}?study={STUDY}#/")
        pg.locator(".srclink.k-fact").wait_for(timeout=30000)
        assert pg.evaluate("document.documentElement.scrollWidth") <= 375
        pg.locator(".srclink.k-fact").click()
        assert pg.locator("#panel .src.fact.sel").is_visible()
        browser.close()


def test_a_repository_with_several_papers_picks_one(page, gh):
    main = gh.repos[STUDY]["main"]
    second = {**sources(), "paper": "paper2", "title": "The timing cost of scattering: a joint position--time bound",
              "draft": "paper2/draft.pdf", "facts": {}, "claims": [], "unsourced": []}
    (main / "report" / "sources-paper2.json").write_text(json.dumps(second))
    (main / "report" / "sources-paper.json").write_text(json.dumps({**sources(), "title": "Depth from scattering"}))
    page.goto(f"{gh.url}?study={STUDY}#/")
    pick = page.get_by_label("Which paper")
    pick.wait_for(timeout=30000)
    assert pick.locator("option").all_inner_texts() == ["paper: Depth from scattering", "paper2: The timing cost of scattering: a joint position–time bound"]
    pick.select_option("paper2")
    page.wait_for_url("**paper=paper2**")
    page.get_by_text("No draft PDF of paper2 yet").wait_for(timeout=30000)
    assert page.get_by_label("Which paper").input_value() == "paper2"
    assert not page.errors


def test_no_draft_yet_still_lists_the_sources(page, gh):
    del gh.repos[STUDY]["drafts"]
    page.goto(f"{gh.url}?study={STUDY}#/")
    page.get_by_text("No draft PDF of paper yet").wait_for(timeout=30000)
    assert "design A sensitivity" in page.locator("#panel").inner_text()
    assert not page.errors


def test_a_repository_it_cannot_read_says_how_to_allow_it(page, gh):
    page.goto(f"{gh.url}?study=test/elsewhere#/")
    page.get_by_text("Could not open the study").wait_for(timeout=30000)
    assert page.get_by_role("link", name="add the repository to the app").count() == 1
    page.get_by_role("link", name="Open the library instead").click()
    page.locator(".card").first.wait_for(timeout=10000)
    assert not page.errors
