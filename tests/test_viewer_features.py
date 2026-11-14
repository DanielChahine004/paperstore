"""Every viewer feature in a headless phone-sized browser against tests/fake_github.py.

    uv run --with pytest --with playwright pytest tests/test_viewer_features.py
"""
import pytest

pw = pytest.importorskip("playwright.sync_api")

from test_viewer import KEY, click_status, gh, notes, open_claim, page, unchecked  # noqa: E402,F401  (fixtures too)


def wait_for(page, cond, ms=10000):
    for _ in range(ms // 100):
        if cond():
            return True
        page.wait_for_timeout(100)
    return cond()


def test_library_search_and_claims_filter(page, gh):
    page.goto(gh.url)
    page.locator(".card").first.wait_for(timeout=30000)
    page.locator(".search input").fill("no such paper anywhere")
    assert wait_for(page, lambda: page.locator(".card").count() == 0)
    page.locator(".search input").fill("monte carlo")
    assert wait_for(page, lambda: page.locator(".card").count() == 1)
    page.goto(gh.url + "#/claims")
    rows = page.locator("#main .claim")   # on a phone the claims page is cards, not a table
    rows.first.wait_for(timeout=30000)
    assert rows.count() == len(notes(gh))
    page.locator(".filters select").nth(1).select_option("verified")
    verified = sum(1 for n in notes(gh).values() if n.get("status") == "verified")
    assert wait_for(page, lambda: rows.count() == verified)
    assert not page.errors


def test_find_in_paper(page, gh):
    open_claim(page, gh, unchecked(gh))
    page.get_by_role("button", name="Find in paper").click()
    box = page.get_by_placeholder("Find in paper")
    box.fill("sensitivity")
    box.press("Enter")
    assert wait_for(page, lambda: "/" in page.locator(".findbox .n").inner_text())
    assert wait_for(page, lambda: page.locator(".findhit").count() > 0)
    assert not page.errors


SELECT = """(re) => {
    const s = [...document.querySelectorAll(".page[data-n='1'] .textLayer span")].find((x) => new RegExp(re).test(x.textContent));
    const r = document.createRange(); r.selectNodeContents(s);
    getSelection().removeAllRanges(); getSelection().addRange(r);
    return s.textContent; }"""


def test_new_claim_from_selected_text(page, gh):
    open_claim(page, gh, unchecked(gh))
    page.locator(".page[data-n='1'] .textLayer span").first.wait_for(timeout=30000)
    page.evaluate(SELECT, "NECR peaks were")
    page.locator("#pop button", has_text="Claim").click()
    page.locator("#composer textarea").fill("a note from the test")
    page.locator("#composer button", has_text="Save").click()
    assert wait_for(page, lambda: len(gh.commits) == 1)
    new = [n for n in notes(gh).values() if n.get("note") == "a note from the test"]
    assert len(new) == 1 and new[0]["kind"] == "quote" and "NECR peaks were" in new[0]["quote"]["exact"]
    assert wait_for(page, lambda: page.locator(f".claim[data-id='{new[0]['id']}']").count() == 1)   # shows in the panel
    assert not page.errors


def test_box_a_figure(page, gh):
    open_claim(page, gh, unchecked(gh))
    page.get_by_role("button", name="Box a figure or table (B)").click()
    b = page.locator(".page[data-n='1']").bounding_box()
    top = max(b["y"], 60) + 20   # page 1 may be scrolled partly above the bar
    page.mouse.move(b["x"] + 40, top)
    page.mouse.down()
    page.mouse.move(b["x"] + 160, top + 80, steps=5)
    page.mouse.up()
    page.locator("#composer textarea").fill("a box from the test")
    page.locator("#composer button", has_text="Save").click()
    assert wait_for(page, lambda: len(gh.commits) == 1)
    new = [n for n in notes(gh).values() if n.get("note") == "a box from the test"]
    assert len(new) == 1 and new[0]["kind"] == "area" and new[0]["page"] == 1
    x0, y0, x1, y1 = new[0]["rects"][0]
    assert 0 < x0 < x1 < 1 and 0 < y0 < y1 < 1
    assert not page.errors


def test_edit_note_and_tags(page, gh):
    nid = unchecked(gh)
    open_claim(page, gh, nid)
    card = page.locator(f".claim[data-id='{nid}']")
    card.get_by_role("button", name="Edit note and tags").click()
    card.locator("textarea").fill("edited by the test")
    card.locator(".edit input").fill("one two")
    card.locator(".edit button", has_text="Save").click()
    assert wait_for(page, lambda: notes(gh)[nid].get("note") == "edited by the test")
    assert notes(gh)[nid]["tags"] == ["one", "two"]
    assert wait_for(page, lambda: "edited by the test" in page.locator(f".claim[data-id='{nid}'] .note").inner_text())
    assert not page.errors


def test_delete_claim(page, gh):
    nid = unchecked(gh)
    open_claim(page, gh, nid)
    page.once("dialog", lambda d: d.accept())
    page.locator(f".claim[data-id='{nid}']").get_by_role("button", name="Delete").click()
    assert wait_for(page, lambda: nid not in notes(gh))
    assert wait_for(page, lambda: page.locator(f".claim[data-id='{nid}']").count() == 0)
    assert not page.errors


def test_copy_link(page, gh):
    nid = unchecked(gh)
    page.context.grant_permissions(["clipboard-read", "clipboard-write"], origin=gh.url.rstrip("/"))
    open_claim(page, gh, nid)
    page.locator(f".claim[data-id='{nid}']").get_by_role("button", name="Copy a link to this claim").click()
    assert wait_for(page, lambda: page.evaluate("navigator.clipboard.readText()").endswith(f"#/{KEY}/{nid}"))


def test_save_retries_when_someone_else_saved_first(page, gh):
    nid = unchecked(gh)
    open_claim(page, gh, nid)
    gh.conflicts = 1
    click_status(page, nid, "Disputed")
    assert wait_for(page, lambda: notes(gh)[nid].get("status") == "disputed")
    assert gh.conflicts == 0 and len(gh.commits) == 1
    assert not page.errors


def test_read_only_collaborator_sees_no_edit_controls(page, gh):
    gh.push = False
    nid = unchecked(gh)
    page.goto(f"{gh.url}#/{KEY}/{nid}")
    page.locator(f".claim[data-id='{nid}']").wait_for(timeout=30000)
    assert page.locator(".seg[aria-label=Status]").count() == 0
    assert page.get_by_role("button", name="Box a figure or table (B)").count() == 0
    assert page.locator(f".claim[data-id='{nid}']").get_by_role("button", name="Copy a link to this claim").count() == 1


def test_signed_out_shows_sign_in(page, gh):
    gh.signed_out = True
    page.goto(gh.url)
    page.get_by_text("Sign in with a code").wait_for(timeout=30000)
    assert page.evaluate("localStorage.getItem('ps.token')") is None


def test_demo_opens_without_sign_in(gh):
    with pw.sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page()
        pg.goto(gh.url + "?demo#/")
        pg.locator(".card").first.wait_for(timeout=30000)
        assert pg.locator(".card").count() == 1
        b.close()


def test_phone_panel_closes_and_reopens(page, gh):
    open_claim(page, gh, unchecked(gh))
    page.locator("#panel").get_by_role("button", name="Close").click()
    assert page.locator("#panel").is_hidden()
    page.get_by_role("button", name="Claims and details").click()
    assert page.locator("#panel").is_visible()


def test_theme_button_cycles_and_is_remembered(page, gh):
    page.goto(gh.url)
    page.locator(".card").first.wait_for(timeout=30000)
    root = lambda: page.evaluate("[document.documentElement.dataset.theme || '', document.documentElement.dataset.pages || '']")
    bg = lambda: page.evaluate("getComputedStyle(document.body).backgroundColor")
    light_bg = bg()
    assert root() == ["", ""]
    seen = []
    for _ in range(4):
        page.locator(".themebtn").click()
        seen.append(root())
    assert seen == [["dark", ""], ["dark", "original"], ["light", ""], ["", ""]]
    page.locator(".themebtn").click()   # dark, then reload: kept, and set before the app runs
    dark_bg = bg()
    page.reload()
    assert page.evaluate("document.documentElement.dataset.theme") == "dark"
    page.locator(".card").first.wait_for(timeout=30000)
    assert bg() == dark_bg != light_bg


def test_dark_mode_dims_pages_and_quotes_read_as_quotes(gh):
    with pw.sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(color_scheme="dark", viewport={"width": 390, "height": 844})
        ctx.add_init_script("localStorage.setItem('ps.token', 'fake')")
        pg = ctx.new_page()
        pg.goto(f"{gh.url}#/{KEY}/{next(iter(notes(gh)))}")
        pg.locator(".page canvas").first.wait_for(timeout=30000)
        assert "invert" in pg.evaluate("getComputedStyle(document.querySelector('.page canvas')).filter")
        q = pg.locator(".claim:not(.area) blockquote").first
        q.wait_for(timeout=30000)
        assert q.evaluate("(e) => getComputedStyle(e).fontStyle") == "italic"
        assert q.evaluate("(e) => getComputedStyle(e, '::before').content") == '"“"'
        assert pg.locator(".claim .note").first.evaluate("(e) => getComputedStyle(e, '::before').content") == '"Note"'
        b.close()


def test_quote_link_opens_page_and_highlights_it(page, gh):
    # #/<Key>/p<page>/<quote>: a link from elsewhere (the explainer videos' sources), across a line-end hyphen
    q = "the University of Pennsylvania, resulted in the first TB-PET systems"
    page.goto(f"{gh.url}#/{KEY}/p2/" + __import__("urllib.parse").parse.quote(q, safe=""))
    assert wait_for(page, lambda: page.locator(".page[data-n='2'] .hl.quote").count() >= 2, 30000)
    box = page.locator(".page[data-n='2'] .hl.quote").first.bounding_box()
    assert box and box["width"] > 20 and box["height"] > 5
    assert page.evaluate("Math.abs(document.querySelector(\".page[data-n='2'] .hl.quote\").getBoundingClientRect().top) < innerHeight")
    page.goto(f"{gh.url}#/{KEY}/p3/" + __import__("urllib.parse").parse.quote(q, safe=""))
    assert wait_for(page, lambda: page.locator(".hl.quote").count() == 0)
    assert not page.errors
