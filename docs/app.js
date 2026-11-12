// Paper Store viewer: reads a paper store from a private GitHub repo in the browser,
// shows each PDF with its annotations, and saves new ones back as commits.
// Same files as the paperstore CLI: references.bib, <Key>.pdf, annotations/<Key>.json.
import * as pdfjs from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";

const CFG = window.PAPERSTORE || {};
const params = new URLSearchParams(location.search);
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
	const e = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k === "class") e.className = v;
		else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
		else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v);
	}
	for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k);
	return e;
};
const toast = (msg, ms = 2500) => { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms); };

// ---- sign-in --------------------------------------------------------------------------------

const auth = {
	get token() { try { return localStorage.getItem("ps.token"); } catch { return null; } },
	set(tok, refresh, expiresIn) {
		try {
			localStorage.setItem("ps.token", tok);
			if (refresh) localStorage.setItem("ps.refresh", refresh);
			if (expiresIn) localStorage.setItem("ps.expires", String(Date.now() + expiresIn * 1000));
		} catch { /* private window: lasts this visit */ }
		this._mem = tok;
	},
	clear() { try { ["ps.token", "ps.refresh", "ps.expires"].forEach((k) => localStorage.removeItem(k)); } catch {} },
	// tokens from the sign-in helper arrive once in the fragment: #token=...&refresh=...&expires_in=...&then=/Key
	takeFromFragment() {
		if (!location.hash.startsWith("#token=")) return;
		const p = new URLSearchParams(location.hash.slice(1));
		this.set(p.get("token"), p.get("refresh"), Number(p.get("expires_in")) || 0);
		history.replaceState(null, "", location.pathname + location.search + "#" + (p.get("then") || "/"));
	},
	async fresh() {
		let tok = this.token || this._mem;
		const exp = Number(localStorage.getItem("ps.expires") || 0), refresh = localStorage.getItem("ps.refresh");
		if (tok && exp && refresh && CFG.auth && Date.now() > exp - 5 * 60e3) {
			const r = await fetch(CFG.auth.replace(/\/$/, "") + "/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: refresh }) });
			if (r.ok) { const j = await r.json(); this.set(j.access_token, j.refresh_token, j.expires_in); tok = j.access_token; }
		}
		return tok;
	},
	login() {
		const back = location.origin + location.pathname + location.search;
		location.href = CFG.auth.replace(/\/$/, "") + "/login?then=" + encodeURIComponent(location.hash.slice(1) || "/") + "&back=" + encodeURIComponent(back);
	},
};

// ---- where the files come from ----------------------------------------------------------------

class GitHubSource {
	constructor(repo, branch) { this.repo = repo; this.branch = branch || "main"; this.writable = true; }
	async req(path, opts = {}) {
		const tok = await auth.fresh();
		const r = await fetch(`https://api.github.com/repos/${this.repo}/${path}`, {
			...opts, headers: { Authorization: `Bearer ${tok}`, "X-GitHub-Api-Version": "2022-11-28", ...(opts.headers || {}) } });
		if (r.status === 401) { auth.clear(); throw new Error("signed out: sign in again"); }
		return r;
	}
	async user() {
		const r = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${await auth.fresh()}` } });
		if (!r.ok) throw new Error(r.status === 401 ? "that token was refused" : `GitHub said ${r.status}`);
		return (await r.json()).login;
	}
	async text(path) {
		const r = await this.req(`contents/${encodeURI(path)}?ref=${this.branch}`, { headers: { Accept: "application/vnd.github.raw" } });
		if (r.status === 404) return null;
		if (!r.ok) throw new Error(`${path}: GitHub said ${r.status}`);
		return r.text();
	}
	async bytes(path) {
		const r = await this.req(`contents/${encodeURI(path)}?ref=${this.branch}`, { headers: { Accept: "application/vnd.github.raw" } });
		if (!r.ok) throw new Error(`${path}: GitHub said ${r.status}`);
		return r.arrayBuffer();
	}
	async list(dir) {
		const r = await this.req(`contents/${dir}?ref=${this.branch}`);
		if (r.status === 404) return [];
		return (await r.json()).map((f) => f.name);
	}
	// read-modify-write with the file's sha, retried once if someone saved in between
	async update(path, change, message) {
		for (let attempt = 0; attempt < 3; attempt++) {
			const r = await this.req(`contents/${encodeURI(path)}?ref=${this.branch}`);
			let sha, old = null;
			if (r.ok) { const j = await r.json(); sha = j.sha; old = new TextDecoder().decode(Uint8Array.from(atob(j.content.replace(/\n/g, "")), (c) => c.charCodeAt(0))); }
			const body = change(old);
			const bytes = new TextEncoder().encode(body);
			let bin = ""; bytes.forEach((b) => (bin += String.fromCharCode(b)));
			const put = await this.req(`contents/${encodeURI(path)}`, { method: "PUT", headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message, content: btoa(bin), sha, branch: this.branch }) });
			if (put.ok) return body;
			if (put.status !== 409 && put.status !== 422) throw new Error(`save failed: GitHub said ${put.status}`);
		}
		throw new Error("save failed: the file kept changing; reload and try again");
	}
}

class StaticSource {   // a read-only store served beside the viewer (the demo); edits live in memory
	constructor(base) { this.base = base; this.mem = {}; this.writable = false; }
	async user() { return "demo"; }
	async text(path) { if (path in this.mem) return this.mem[path]; const r = await fetch(this.base + path); return r.ok ? r.text() : null; }
	async bytes(path) { const r = await fetch(this.base + path); if (!r.ok) throw new Error(path + " not found"); return r.arrayBuffer(); }
	async list(dir) { const t = await this.text(dir + "/index.txt"); return t ? t.split(/\s+/).filter(Boolean) : []; }
	async update(path, change) { this.mem[path] = change(await this.text(path)); return this.mem[path]; }
}

// ---- the store ------------------------------------------------------------------------------

function parseBib(text) {
	const out = [];
	const field = (body, name) => {
		const m = new RegExp(`\\b${name}\\s*=\\s*\\{`, "i").exec(body);
		if (!m) return "";
		let i = m.index + m[0].length, depth = 1, s = "";
		for (; i < body.length && depth; i++) { const c = body[i]; if (c === "{") depth++; else if (c === "}") depth--; if (depth) s += c; }
		return s.replace(/[{}]/g, "").replace(/\\&/g, "&").replace(/\\([%#_$])/g, "$1").replace(/--/g, "–").trim();
	};
	for (const m of text.matchAll(/@(\w+)\s*\{\s*([^,\s]+)\s*,([\s\S]*?)\n\}/g)) {
		const body = m[3];
		const authors = field(body, "author").split(/\s+and\s+/).filter(Boolean);
		out.push({ kind: m[1].toLowerCase(), key: m[2], title: field(body, "title"), authors,
			year: (field(body, "date") || field(body, "year")).slice(0, 4), venue: field(body, "journaltitle") || field(body, "booktitle") || field(body, "publisher"),
			doi: field(body, "doi"), file: field(body, "file"), nopdf: field(body, "nopdf") });
	}
	return out;
}
const shortAuthors = (a) => { const s = (n) => n.split(",")[0].replace(/[{}]/g, ""); return a.length > 2 ? `${s(a[0])} et al.` : a.map(s).join(" & "); };

const S = { src: null, me: "", papers: [], counts: {}, notes: {}, scale: Number(localStorage.getItem("ps.scale")) || 1.25, boxing: false };

async function loadStore() {
	S.papers = parseBib((await S.src.text("references.bib")) || "");
	S.counts = {};
	for (const f of await S.src.list("annotations")) if (f.endsWith(".json")) S.counts[f.slice(0, -5)] = null;   // counted when opened
}
async function notesOf(key) {
	if (!(key in S.notes)) {
		const t = await S.src.text(`annotations/${key}.json`);
		S.notes[key] = t ? JSON.parse(t).annotations : [];
		S.counts[key] = S.notes[key].length;
	}
	return S.notes[key];
}
async function saveNotes(key, op, message) {
	// apply op to the latest copy, so two people saving at once both keep their edits
	const body = await S.src.update(`annotations/${key}.json`, (old) => {
		const list = old ? JSON.parse(old).annotations : [];
		return JSON.stringify({ paper: key, annotations: op(list) }, null, 1) + "\n";
	}, message);
	S.notes[key] = JSON.parse(body).annotations;
	S.counts[key] = S.notes[key].length;
	if (!S.src.writable) toast("demo: changes are kept until you reload");
}
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, "0")).join("");
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

// ---- views ----------------------------------------------------------------------------------

function signinView(err) {
	$("#main").replaceChildren(el("div", { class: "signin" },
		el("h2", {}, "Paper Store"),
		el("p", {}, `Papers and annotations from ${CFG.repo}. Only people with access to that repository can open them.`),
		err ? el("p", { style: "color:#c62f2f" }, err) : null,
		CFG.auth ? el("button", { class: "on", onclick: () => auth.login() }, "Sign in with GitHub") : null,
		el("details", { open: !CFG.auth || undefined }, el("summary", {}, "Use an access token instead"),
			el("p", {}, "A fine-grained token limited to this repository, with Contents: read and write. It stays in this browser."),
			el("form", { onsubmit: (e) => { e.preventDefault(); auth.set(e.target.tok.value.trim()); start(); } },
				el("input", { name: "tok", type: "password", autocomplete: "off", placeholder: "github_pat_…" }), el("p", {}, el("button", {}, "Use token")))),
		el("p", {}, el("a", { href: "?demo" }, "Try the demo store"), " (no sign-in)")));
}

function libraryView() {
	setChrome();
	const q = el("input", { placeholder: "Filter by key, title, author, year or venue", value: sessionStorage.getItem("ps.q") || "" });
	const only = el("select", {}, el("option", { value: "" }, "All papers"), el("option", { value: "notes" }, "With annotations"), el("option", { value: "missing" }, "No PDF"));
	const list = el("div");
	const draw = () => {
		sessionStorage.setItem("ps.q", q.value);
		const terms = q.value.toLowerCase().split(/\s+/).filter(Boolean);
		list.replaceChildren(...S.papers.filter((p) => {
			const hay = `${p.key} ${p.title} ${p.authors.join(" ")} ${p.year} ${p.venue}`.toLowerCase();
			if (only.value === "notes" && !(p.key in S.counts)) return false;
			if (only.value === "missing" && p.file) return false;
			return terms.every((t) => hay.includes(t));
		}).map((p) => el("a", { class: "paper" + (p.file ? "" : " nopdf"), href: p.file ? `#/${p.key}` : (p.doi ? `https://doi.org/${p.doi}` : "#/") },
			el("div", { class: "t" }, p.title, p.key in S.counts ? el("span", { class: "badge", title: "annotated" }, S.counts[p.key] ?? "✎") : null),
			el("div", { class: "m" }, `${p.key} · ${shortAuthors(p.authors)} · ${p.year} · ${p.venue}` + (p.file ? "" : " · no PDF")))));
	};
	q.addEventListener("input", draw); only.addEventListener("change", draw);
	$("#main").replaceChildren(el("div", { class: "center" }, el("div", { class: "filters" }, q, only), list));
	draw();
}

async function allNotesView() {
	setChrome("All annotations");
	const wrap = el("div", { class: "center" }, el("p", {}, "Loading…"));
	$("#main").replaceChildren(wrap);
	const rows = [];
	for (const key of Object.keys(S.counts)) for (const n of await notesOf(key)) rows.push({ key, n });
	const tag = el("input", { placeholder: "tag" }), who = el("input", { placeholder: "by" }), text = el("input", { placeholder: "search quotes and notes" });
	const status = el("select", {}, ...["", "unchecked", "verified", "disputed"].map((s) => el("option", { value: s }, s || "any status")));
	const list = el("div");
	const draw = () => list.replaceChildren(...rows.filter(({ n }) =>
		(!tag.value || (n.tags || []).includes(tag.value)) && (!who.value || n.creator === who.value) &&
		(!status.value || (n.status || "unchecked") === status.value) &&
		(!text.value || JSON.stringify(n).toLowerCase().includes(text.value.toLowerCase()))
	).map(({ key, n }) => noteCard(key, n, false)));
	[tag, who, text].forEach((i) => i.addEventListener("input", draw)); status.addEventListener("change", draw);
	wrap.replaceChildren(el("div", { class: "filters" }, text, tag, who, status), list, el("p", { class: "meta" }, `${rows.length} annotations`));
	draw();
}

function setChrome(crumb = "", reader = false) {
	$("#crumb").textContent = crumb;
	$("#tools").hidden = !reader;
	$("#side").hidden = !reader || document.body.classList.contains("noside");
	document.body.classList.toggle("withside", reader && !$("#side").hidden);
	$("#who").textContent = S.me ? (S.src.writable ? S.me : "demo (read-only)") : "";
}

// ---- the reader -----------------------------------------------------------------------------

let R = null;   // the open paper: {key, paper, doc, pages: [{div, w, h, done}], observer}

async function readerView(key, noteId) {
	const paper = S.papers.find((p) => p.key === key);
	if (!paper) return libraryView();
	if (!R || R.key !== key) {
		setChrome(`${shortAuthors(paper.authors)} ${paper.year} — ${paper.title}`, true);
		$("#main").replaceChildren(el("p", { class: "center" }, "Opening " + key + "…"));
		const [data] = await Promise.all([S.src.bytes(paper.file || key + ".pdf"), notesOf(key)]);
		const doc = await pdfjs.getDocument({ data }).promise;
		R = { key, paper, doc, pages: [] };
		await layout();
	} else setChrome($("#crumb").textContent, true);
	drawSide();
	drawHighlights();
	if (noteId) focusNote(noteId, true);
}

async function layout() {
	const box = el("div", { id: "pages" });
	$("#main").replaceChildren(box);
	R.observer?.disconnect();
	R.observer = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && renderPage(Number(e.target.dataset.n))), { rootMargin: "800px" });
	R.pages = [];
	const first = await R.doc.getPage(1);
	const vp1 = first.getViewport({ scale: S.scale });
	const fit = Math.min(1, (innerWidth - (innerWidth > 800 && !$("#side").hidden ? 400 : 32)) / vp1.width);
	R.scale = S.scale * fit;
	for (let n = 1; n <= R.doc.numPages; n++) {
		const vp = (n === 1 ? first : await R.doc.getPage(n)).getViewport({ scale: R.scale });
		const div = el("div", { class: "page", "data-n": n, style: `width:${vp.width}px;height:${vp.height}px;--scale-factor:${R.scale}` }, el("span", { class: "pno" }, `p.${n}`));
		box.append(div);
		R.pages[n] = { div, w: vp.width, h: vp.height, done: false };
		R.observer.observe(div);
		attachBoxDrawing(div, n);
	}
}

async function renderPage(n) {
	const P = R.pages[n];
	if (P.done) return;
	P.done = true;
	const page = await R.doc.getPage(n);
	const vp = page.getViewport({ scale: R.scale });
	const ratio = window.devicePixelRatio || 1;
	const canvas = el("canvas", { width: Math.floor(vp.width * ratio), height: Math.floor(vp.height * ratio) });
	P.div.prepend(canvas);
	await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null }).promise;
	const tl = el("div", { class: "textLayer" });
	P.div.append(tl);
	await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp }).render();
}

function drawHighlights() {
	document.querySelectorAll(".hl").forEach((h) => h.remove());
	for (const n of S.notes[R.key] || []) {
		const P = R.pages[n.page];
		if (!P) continue;
		for (const [x0, y0, x1, y1] of n.rects || []) {
			P.div.append(el("div", { class: `hl ${n.status || ""} ${n.kind === "area" ? "area" : ""}`, "data-id": n.id, title: n.note || "",
				style: `left:${x0 * 100}%;top:${y0 * 100}%;width:${(x1 - x0) * 100}%;height:${(y1 - y0) * 100}%`,
				onclick: () => focusNote(n.id, false) }));
		}
	}
}

function focusNote(id, scroll) {
	document.querySelectorAll(".note.sel").forEach((x) => x.classList.remove("sel"));
	const card = document.querySelector(`#side .note[data-id="${id}"]`);
	card?.classList.add("sel");
	card?.scrollIntoView({ block: "nearest" });
	const n = (S.notes[R.key] || []).find((x) => x.id === id);
	if (!n) return;
	const hl = document.querySelectorAll(`.hl[data-id="${id}"]`);
	if (scroll) {
		const P = R.pages[n.page];
		const y = P.div.offsetTop + (n.rects?.[0]?.[1] || 0) * P.h - innerHeight / 3;
		scrollTo({ top: y, behavior: "smooth" });
	}
	hl.forEach((h) => { h.classList.remove("flash"); void h.offsetWidth; h.classList.add("flash"); });
	if (location.hash !== `#/${R.key}/${id}`) history.replaceState(null, "", `#/${R.key}/${id}`);
}

function drawSide() {
	const p = R.paper, notes = (S.notes[R.key] || []).slice().sort((a, b) => a.page - b.page || (a.rects?.[0]?.[1] || 0) - (b.rects?.[0]?.[1] || 0));
	$("#side").replaceChildren(...[
		el("h3", {}, p.title),
		el("div", { class: "meta" }, `${p.authors.map((a) => a.split(",")[0]).join(", ")} · ${p.year} · ${p.venue} · `,
			p.doi ? el("a", { href: `https://doi.org/${p.doi}`, target: "_blank", rel: "noopener" }, "DOI") : null, ` · ${p.key}`),
		notes.length ? null : el("p", { class: "meta" }, "No annotations yet. Select text and press Annotate, or press Box to mark a figure or table."),
		...notes.map((n) => noteCard(R.key, n, true))].filter(Boolean));
}

function noteCard(key, n, inReader) {
	const quote = n.quote?.exact || (n.kind === "area" ? "[box" + (n.label ? ": " + n.label : " on the page") + "]" : "");
	const v = n.value ? `${n.value.what ? n.value.what + " = " : ""}${n.value.number} ${n.value.unit || ""}` : "";
	const card = el("div", { class: "note", "data-id": n.id },
		el("q", { onclick: () => (inReader ? focusNote(n.id, true) : (location.hash = `#/${key}/${n.id}`)) }, quote),
		v ? el("div", { class: "val" }, v) : null,
		n.note ? el("div", {}, n.note) : null,
		el("div", { class: "by" }, inReader ? null : el("a", { href: `#/${key}/${n.id}` }, key), `p.${n.page} · ${n.creator || ""} ·`,
			el("span", { class: "st-" + (n.status || "unchecked") }, n.status || "unchecked"),
			...(n.tags || []).map((t) => el("span", { class: "tag" }, "#" + t))));
	if (inReader && S.src) {
		const status = el("select", { onchange: () => edit(key, n.id, { status: status.value }, "mark " + status.value) },
			...["unchecked", "verified", "disputed"].map((s) => el("option", { value: s, selected: (n.status || "unchecked") === s || undefined }, s)));
		card.append(el("div", { class: "acts" }, status,
			el("button", { onclick: () => editNoteText(card, key, n) }, "Edit"),
			el("button", { onclick: () => { navigator.clipboard?.writeText(location.href.split("#")[0] + `#/${key}/${n.id}`); toast("link copied"); } }, "Link"),
			el("button", { onclick: () => confirm("Delete this annotation?") && removeNote(key, n.id) }, "Delete")));
	}
	return card;
}

function editNoteText(card, key, n) {
	const ta = el("textarea", { rows: 3 }); ta.value = n.note || "";
	const tags = el("input", { value: (n.tags || []).join(" "), placeholder: "tags" });
	card.append(ta, tags, el("div", { class: "acts" }, el("button", { onclick: () => edit(key, n.id, { note: ta.value, tags: tags.value.split(/\s+/).filter(Boolean) }, "edit note") }, "Save")));
}

async function edit(key, id, patch, what) {
	try {
		await saveNotes(key, (list) => list.map((x) => (x.id === id ? { ...x, ...patch, modified: nowIso() } : x)), `${key}: ${what} (${id})`);
		drawSide(); drawHighlights(); focusNote(id, false);
	} catch (e) { toast(e.message, 5000); }
}
async function removeNote(key, id) {
	try { await saveNotes(key, (list) => list.filter((x) => x.id !== id), `${key}: delete annotation ${id}`); drawSide(); drawHighlights(); }
	catch (e) { toast(e.message, 5000); }
}

// ---- making annotations ---------------------------------------------------------------------

function selectionTarget() {
	const sel = getSelection();
	if (!sel || sel.isCollapsed || !R) return null;
	const range = sel.getRangeAt(0).cloneRange();   // widened to whole words: "than", not "han"
	const word = /[\p{L}\p{N}]/u;
	if (range.startContainer.nodeType === 3) { const t = range.startContainer.data; let i = range.startOffset; while (i > 0 && word.test(t[i - 1])) i--; range.setStart(range.startContainer, i); }
	if (range.endContainer.nodeType === 3) { const t = range.endContainer.data; let i = range.endOffset; while (i < t.length && word.test(t[i])) i++; range.setEnd(range.endContainer, i); }
	const pageDiv = (range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)?.closest(".page");
	if (!pageDiv) return null;
	const n = Number(pageDiv.dataset.n), box = pageDiv.getBoundingClientRect();
	const lines = [];
	for (const r of range.getClientRects()) {
		if (r.width < 1 || r.height < 1) continue;
		const f = [(r.left - box.left) / box.width, (r.top - box.top) / box.height, (r.right - box.left) / box.width, (r.bottom - box.top) / box.height];
		const same = lines.find((l) => Math.abs((l[1] + l[3]) / 2 - (f[1] + f[3]) / 2) < (f[3] - f[1]) / 2);
		if (same) { same[0] = Math.min(same[0], f[0]); same[2] = Math.max(same[2], f[2]); same[1] = Math.min(same[1], f[1]); same[3] = Math.max(same[3], f[3]); }
		else lines.push(f);
	}
	const text = range.toString().replace(/\s+/g, " ").trim();
	if (!text || !lines.length) return null;
	return { page: n, text, rects: lines.map((l) => l.map((x) => Math.round(Math.min(1, Math.max(0, x)) * 1e4) / 1e4)), at: range.getBoundingClientRect() };
}

function placeAnnotateButton() {
	const t = selectionTarget(), b = $("#annotate");
	if (!t) { b.hidden = true; return; }
	b.hidden = false;
	b.style.left = `${Math.min(innerWidth - 110, Math.max(8, t.at.left + t.at.width / 2 - 45))}px`;
	b.style.top = `${t.at.bottom + 8 > innerHeight - 50 ? t.at.top - 44 : t.at.bottom + 8}px`;
}

async function openForm(target) {
	const d = $("#form");
	$("#f-quote").textContent = target.kind === "area" ? `Box on page ${target.page}` : target.text;
	["#f-note", "#f-tags", "#f-value", "#f-unit", "#f-what"].forEach((s) => ($(s).value = ""));
	d.showModal();
	$("#f-note").focus();
	const v = await new Promise((res) => d.addEventListener("close", () => res(d.returnValue), { once: true }));
	if (v !== "save") return;
	const n = { id: newId(), created: nowIso(), creator: S.me, kind: target.kind, page: target.page,
		...(target.kind === "quote" ? { quote: { exact: target.text } } : {}),
		rects: target.rects, note: $("#f-note").value.trim(), tags: $("#f-tags").value.split(/\s+/).filter(Boolean), status: "unchecked" };
	const num = parseFloat($("#f-value").value);
	if (!Number.isNaN(num)) n.value = { number: num, ...($("#f-unit").value ? { unit: $("#f-unit").value } : {}), ...($("#f-what").value ? { what: $("#f-what").value } : {}) };
	try {
		await saveNotes(R.key, (list) => [...list, n], `${R.key}: annotate p.${n.page} (${n.id})`);
		getSelection()?.removeAllRanges(); $("#annotate").hidden = true;
		drawSide(); drawHighlights(); focusNote(n.id, false);
		toast("saved");
	} catch (e) { toast(e.message, 5000); }
}

function attachBoxDrawing(div, n) {
	let start = null, box = null;
	div.addEventListener("pointerdown", (e) => {
		if (!S.boxing) return;
		e.preventDefault();
		const r = div.getBoundingClientRect();
		start = [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
		box = el("div", { class: "drawing" }); div.append(box);
		div.setPointerCapture(e.pointerId);
	});
	div.addEventListener("pointermove", (e) => {
		if (!start) return;
		const r = div.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
		Object.assign(box.style, { left: `${Math.min(x, start[0]) * 100}%`, top: `${Math.min(y, start[1]) * 100}%`, width: `${Math.abs(x - start[0]) * 100}%`, height: `${Math.abs(y - start[1]) * 100}%` });
	});
	div.addEventListener("pointerup", (e) => {
		if (!start) return;
		const r = div.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
		const rect = [Math.min(x, start[0]), Math.min(y, start[1]), Math.max(x, start[0]), Math.max(y, start[1])].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 1e4) / 1e4);
		start = null; box.remove();
		if (rect[2] - rect[0] > 0.01 && rect[3] - rect[1] > 0.005) { setBoxing(false); openForm({ kind: "area", page: n, rects: [rect] }); }
	});
}
function setBoxing(on) { S.boxing = on; $("#boxmode").classList.toggle("on", on); document.body.classList.toggle("boxing", on); }

// ---- wiring ---------------------------------------------------------------------------------

async function route() {
	$("#annotate").hidden = true;
	const [, a, b] = location.hash.replace(/^#/, "").split("/");
	try {
		if (!a) return libraryView();
		if (a === "notes") return allNotesView();
		return await readerView(decodeURIComponent(a), b);
	} catch (e) { $("#main").replaceChildren(el("p", { class: "center" }, "Could not open: " + e.message)); }
}

async function start() {
	auth.takeFromFragment();
	const demo = params.has("demo");
	if (demo) S.src = new StaticSource(CFG.demo || "demo/");
	else {
		if (!(auth.token || auth._mem)) return signinView();
		S.src = new GitHubSource(params.get("repo") || CFG.repo, CFG.branch);
	}
	try { S.me = await S.src.user(); await loadStore(); }
	catch (e) { auth.clear(); return signinView(e.message); }
	await route();
}

addEventListener("hashchange", route);
document.addEventListener("selectionchange", () => { clearTimeout(placeAnnotateButton.t); placeAnnotateButton.t = setTimeout(placeAnnotateButton, 150); });
$("#annotate").addEventListener("pointerdown", (e) => e.preventDefault());   // keep the selection
$("#annotate").addEventListener("click", () => { const t = selectionTarget(); if (t) openForm({ kind: "quote", ...t }); });
$("#boxmode").addEventListener("click", () => setBoxing(!S.boxing));
$("#sidetoggle").addEventListener("click", () => { document.body.classList.toggle("noside"); setChrome($("#crumb").textContent, true); });
$("#zoomin").addEventListener("click", () => zoom(1.2));
$("#zoomout").addEventListener("click", () => zoom(1 / 1.2));
addEventListener("keydown", (e) => {
	if (e.target.closest("input, textarea, dialog")) return;
	if (e.key === "b" || e.key === "B") setBoxing(!S.boxing);
	if (e.key === "Escape") setBoxing(false);
});
async function zoom(f) {
	if (!R) return;
	S.scale = Math.min(4, Math.max(0.5, S.scale * f));
	try { localStorage.setItem("ps.scale", S.scale); } catch {}
	const keep = scrollY / document.body.scrollHeight;
	await layout(); drawHighlights();
	scrollTo(0, keep * document.body.scrollHeight);
}
start();
