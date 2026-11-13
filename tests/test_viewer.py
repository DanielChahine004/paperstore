"""The viewer in a real (headless) browser against tests/fake_github.py.

    uv run --with pytest --with playwright pytest tests/test_viewer.py
(once: uv run --with playwright playwright install chromium)
"""
import json
import shutil
from pathlib import Path

import pytest

pw = pytest.importorskip("playwright.sync_api")

from fake_github import FakeGitHub  # noqa: E402

DEMO = Path(__file__).resolve().parents[1] / "docs" / "demo"
KEY = "AbiAkl2023"


@pytest.fixture
def gh(tmp_path):
    shutil.copytree(DEMO, tmp_path / "store")
    g = FakeGitHub(tmp_path / "store").start()
    yield g
    g.stop()


@pytest.fixture
def page(gh):
    with pw.sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 390, "height": 844})   # phone-sized
        ctx.add_init_script("localStorage.setItem('ps.token', 'fake')")
        pg = ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.errors = errors
        yield pg
        browser.close()


def notes(gh):
    return {n["id"]: n for n in json.loads((gh.store / "annotations" / f"{KEY}.json").read_text(encoding="utf-8"))["annotations"]}


def unchecked(gh):
    return next(i for i, n in notes(gh).items() if (n.get("status") or "unchecked") == "unchecked")


def seg(page, nid):
    return page.locator(f".claim[data-id='{nid}'] .seg[aria-label=Status]").first


def open_claim(page, gh, nid):
    page.goto(f"{gh.url}#/{KEY}/{nid}")
    seg(page, nid).wait_for(timeout=30000)


def click_status(page, nid, label):
    seg(page, nid).locator("button", has_text=label).click()


def wait_commits(page, gh, n):
    for _ in range(100):
        if len(gh.commits) >= n:
            return
        page.wait_for_timeout(100)


def test_library_lists_the_paper(page, gh):
    page.goto(gh.url)
    page.get_by_text(KEY, exact=False).first.wait_for(timeout=30000)
    assert not page.errors


def test_status_buttons_save_to_github(page, gh):
    nid = unchecked(gh)
    open_claim(page, gh, nid)
    for label, status in [("Verified", "verified"), ("Disputed", "disputed"), ("Unchecked", "unchecked")]:
        before = len(gh.commits)
        click_status(page, nid, label)
        wait_commits(page, gh, before + 1)
        assert len(gh.commits) == before + 1, f"{label}: no save; toast: {page.locator('#toast').inner_text()!r}"
        assert gh.commits[-1][0] == f"annotations/{KEY}.json"
        assert (notes(gh)[nid].get("status") or "unchecked") == status
    assert not page.errors
    assert "Cannot read" not in page.locator("#toast").inner_text()


def test_status_survives_reload(page, gh):
    nid = unchecked(gh)
    open_claim(page, gh, nid)
    click_status(page, nid, "Verified")
    wait_commits(page, gh, 1)
    assert len(gh.commits) == 1
    page.reload()
    seg(page, nid).wait_for(timeout=30000)
    assert seg(page, nid).locator("button.on").inner_text() == "Verified"
    assert not page.errors


def test_sign_in_with_a_code(gh):
    with pw.sync_playwright() as p:
        browser = p.chromium.launch()
        pg = browser.new_page(viewport={"width": 390, "height": 844})
        pg.goto(gh.url)
        pg.get_by_text("Sign in with a code").click()
        pg.get_by_text("ABCD-1234").wait_for(timeout=10000)
        pg.get_by_text(KEY, exact=False).first.wait_for(timeout=30000)   # the library, once approved
        assert pg.evaluate("localStorage.getItem('ps.token')") == "fake-device-token"
        assert gh.polls == 2
        browser.close()
