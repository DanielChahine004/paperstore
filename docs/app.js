// Paper Store viewer: reads a paper store from a GitHub repo in the browser, shows each
// PDF with its claims (quote- or box-anchored annotations), and saves edits back as commits.
// Same files as the paperstore CLI: references.bib, <Key>.pdf, thumbs/<Key>.jpg,
// annotations/<Key>.json. Views: #/ library, #/claims, #/<Key>[/<claim id>].
import * as pdfjs from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";

const CFG = window.PAPERSTORE || {};
const API = (CFG.api || "https://api.github.com").replace(/\/$/, "");   // tests point this at a fake GitHub
const params = new URLSearchParams(location.search);
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const store = {   // localStorage that survives a private window refusing it
	get(k, d = null) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
	set(k, v) { try { localStorage.setItem(k, v); } catch {} },
	del(k) { try { localStorage.removeItem(k); } catch {} },
};
function el(tag, attrs = {}, ...kids) {
	const e = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs || {})) {
		if (v === undefined || v === null || v === false) continue;
		if (k === "class") e.className = v;
		else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
		else if (k === "html") e.innerHTML = v;
		else e.setAttribute(k, v === true ? "" : v);
	}
	for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k);
	return e;
}
const PATHS = {
	search: "M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zM20 20l-4-4", back: "M15 18l-6-6 6-6", plus: "M12 5v14M5 12h14", minus: "M5 12h14",
	box: "M4 4h16v16H4z", panel: "M3 4h18v16H3zM15 4v16", link: "M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1",
	edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4", trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13", quote: "M7 7h4v4H8l-1 4M14 7h4v4h-3l-1 4",
	grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z", list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
	up: "M18 15l-6-6-6 6", down: "M6 9l6 6 6-6", close: "M6 6l12 12M18 6L6 18", copy: "M9 9h11v11H9zM5 15H4V4h11v1", out: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
	book: "M4 5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2zM8 7h8",
	moon: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z", sun: "M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
	auto: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 3v18", pages: "M6 3h9l4 4v14H6zM15 3v4h4M9 12h7M9 16h7",
};
const icon = (name) => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("class", "icon"); s.innerHTML = `<path d="${PATHS[name]}"/>`; return s; };
const btn = (name, title, onclick, extra = {}) => el("button", { class: "btn" + (extra.cls ? " " + extra.cls : ""), title, "aria-label": title, onclick, ...extra.attrs }, icon(name), extra.label || null);
const toast = (msg, ms = 2400) => { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms); };
const small = () => matchMedia("(max-width: 760px)").matches;

// ---- theme: auto (the system's), dark, dark with pages in their own colours, light -----------

const THEMES = { auto: "Theme: follows the system", dark: "Theme: dark, pages dimmed", "dark-pages": "Theme: dark, pages in their own colours", light: "Theme: light" };
const theme = {
	get mode() { const m = store.get("ps.theme", "auto"); return m in THEMES ? m : "auto"; },
	apply() {   // index.html sets the same attributes before the page draws, so it never flashes white
		const m = this.mode, root = document.documentElement;
		if (m === "auto") delete root.dataset.theme; else root.dataset.theme = m === "light" ? "light" : "dark";
		if (m === "dark-pages") root.dataset.pages = "original"; else delete root.dataset.pages;
		const meta = $("meta[name=theme-color]");
		if (meta) meta.content = getComputedStyle(root).getPropertyValue("--bg").trim() || "#fbfaf7";
	},
	next() {
		const order = Object.keys(THEMES), m = order[(order.indexOf(this.mode) + 1) % order.length];
		if (m === "auto") store.del("ps.theme"); else store.set("ps.theme", m);
		this.apply();
		toast(THEMES[m]);
		$$(".themebtn").forEach((b) => b.replaceWith(themeBtn()));
	},
};
const themeIcon = { auto: "auto", dark: "moon", "dark-pages": "pages", light: "sun" };
const themeBtn = () => btn(themeIcon[theme.mode], THEMES[theme.mode] + " (tap to change)", () => theme.next(), { cls: "themebtn" });
theme.apply();
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => theme.apply());

// ---- sign-in ------------------------------------------------------------------------------

const auth = {
	get token() { return store.get("ps.token") || this.mem; },
	set(tok, refresh, expiresIn) {
		this.mem = tok;
		store.set("ps.token", tok);
		if (refresh) store.set("ps.refresh", refresh);
		if (expiresIn) store.set("ps.expires", String(Date.now() + expiresIn * 1000));
	},
	clear() { ["ps.token", "ps.refresh", "ps.expires"].forEach((k) => store.del(k)); this.mem = null; },
	takeFromFragment() {   // the sign-in helper returns once to #token=...&refresh=...&expires_in=...&then=/Key
		if (!location.hash.startsWith("#token=")) return;
		const p = new URLSearchParams(location.hash.slice(1));
		this.set(p.get("token"), p.get("refresh"), Number(p.get("expires_in")) || 0);
		history.replaceState(null, "", location.pathname + location.search + "#" + (p.get("then") || "/"));
	},
	async fresh() {
		const exp = Number(store.get("ps.expires", 0)), refresh = store.get("ps.refresh");
		if (this.token && exp && refresh && CFG.auth && Date.now() > exp - 5 * 60e3) {
			const r = await fetch(CFG.auth.replace(/\/$/, "") + "/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: refresh }) });
			if (r.ok) { const j = await r.json(); this.set(j.access_token, j.refresh_token, j.expires_in); }
		}
		return this.token;
	},
	login() {
		const back = location.origin + location.pathname + location.search;
		location.href = CFG.auth.replace(/\/$/, "") + "/login?then=" + encodeURIComponent(location.hash.slice(1) || "/") + "&back=" + encodeURIComponent(back);
	},
};

// ---- where the files come from -------------------------------------------------------------

class GitHubSource {
	constructor(repo, branch) { this.repo = repo; this.branch = branch || "main"; this.writable = true; }
	async req(path, opts = {}) {
		const r = await fetch(`${API}/repos/${this.repo}${path ? "/" + path : ""}`, {   // no trailing slash: GitHub 404s it
			...opts, headers: { Authorization: `Bearer ${await auth.fresh()}`, "X-GitHub-Api-Version": "2022-11-28", ...(opts.headers || {}) } });
		if (r.status === 401) { auth.clear(); throw new Error("signed out: sign in again"); }
		return r;
	}
	async user() {
		const r = await fetch(API + "/user", { headers: { Authorization: `Bearer ${await auth.fresh()}` } });
		if (!r.ok) throw new Error(r.status === 401 ? "GitHub refused the sign-in" : `GitHub said ${r.status}`);
		const login = (await r.json()).login;
		const repo = await this.req("");
		if (!repo.ok) throw new Error(`${login} cannot open ${this.repo}${repo.status === 404 ? " (no access, or no such repository)" : ""}`);
		const perms = (await repo.json()).permissions || {};
		this.canEdit = !!perms.push;     // a Read collaborator gets the viewer without its editing controls
		this.isAdmin = !!perms.admin;    // who may manage access, on GitHub's own page
		return login;
	}
	raw(path, ref = this.branch) { return this.req(`contents/${encodeURI(path)}?ref=${ref}`, { cache: "no-cache", headers: { Accept: "application/vnd.github.raw" } }); }   // revalidated, so a reload shows the latest save
	async text(path, ref) { const r = await this.raw(path, ref); if (r.status === 404) return null; if (!r.ok) throw new Error(`${path}: GitHub said ${r.status}`); return r.text(); }
	async bytes(path, ref) { const r = await this.raw(path, ref); if (!r.ok) throw Object.assign(new Error(`${path}: GitHub said ${r.status}`), { status: r.status }); return r.arrayBuffer(); }
	async blob(path) { const r = await this.raw(path); return r.ok ? r.blob() : null; }
	async list(dir) { const r = await this.req(`contents/${dir}?ref=${this.branch}`); return r.ok ? (await r.json()).map((f) => f.name) : []; }
	async update(path, change, message) {   // read-modify-write on the file's sha; retried if someone saved in between
		for (let i = 0; i < 3; i++) {
			// no-store: a cached copy would be the raw file text() fetched (same URL, other Accept),
			// which has no sha or content, and a stale sha would only bounce the save
			const r = await this.req(`contents/${encodeURI(path)}?ref=${this.branch}`, { cache: "no-store", headers: { Accept: "application/vnd.github.object+json" } });
			let sha, old = null;
			if (r.ok) {
				const j = await r.json();
				if (!j.sha) throw new Error(`save failed: GitHub sent no version of ${path}; reload and try again`);
				sha = j.sha;
				old = j.content   // over 1 MB GitHub leaves content empty; read the raw file instead
					? new TextDecoder().decode(Uint8Array.from(atob(j.content.replace(/\n/g, "")), (c) => c.charCodeAt(0)))
					: await (await this.req(`contents/${encodeURI(path)}?ref=${this.branch}`, { cache: "no-store", headers: { Accept: "application/vnd.github.raw" } })).text();
			}
			const body = change(old), bytes = new TextEncoder().encode(body);
			let bin = ""; bytes.forEach((b) => (bin += String.fromCharCode(b)));
			const put = await this.req(`contents/${encodeURI(path)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, content: btoa(bin), sha, branch: this.branch }) });
			if (put.ok) return body;
			if (put.status !== 409 && put.status !== 422) throw new Error(`save failed: GitHub said ${put.status}`);
		}
		throw new Error("save failed: the file kept changing; reload and try again");
	}
}

class StaticSource {   // a read-only store served beside the viewer (the demo); edits last until reload
	constructor(base) { this.base = base; this.mem = {}; this.writable = false; this.canEdit = true; this.repo = "demo"; }
	async user() { return "demo"; }
	async text(path) { if (path in this.mem) return this.mem[path]; const r = await fetch(this.base + path); return r.ok ? r.text() : null; }
	async bytes(path) { const r = await fetch(this.base + path); if (!r.ok) throw new Error(path + " not found"); return r.arrayBuffer(); }
	async blob(path) { const r = await fetch(this.base + path); return r.ok ? r.blob() : null; }
	async list(dir) { const t = await this.text(dir + "/index.txt"); return t ? t.split(/\s+/).filter(Boolean) : []; }
	async update(path, change) { this.mem[path] = change(await this.text(path)); return this.mem[path]; }
}

// ---- the store ----------------------------------------------------------------------------

function parseBib(text) {
	const out = [];
	const field = (body, name) => {
		const m = new RegExp(`(?:^|[,\\s])${name}\\s*=\\s*\\{`, "i").exec(body);
		if (!m) return "";
		let i = m.index + m[0].length, depth = 1, s = "";
		for (; i < body.length && depth; i++) { const c = body[i]; if (c === "{") depth++; else if (c === "}") depth--; if (depth) s += c; }
		return s.replace(/[{}]/g, "").replace(/\\&/g, "&").replace(/\\([%#_$])/g, "$1").replace(/---/g, "—").replace(/--/g, "–").replace(/\s+/g, " ").trim();
	};
	for (const m of text.matchAll(/@(\w+)\s*\{\s*([^,\s]+)\s*,([\s\S]*?)\n\}/g)) {
		const body = m[3];
		const authors = field(body, "author").split(/\s+and\s+/).filter(Boolean).map((a) => a.includes(",") ? a.split(",")[0].trim() : a.split(" ").pop());
		out.push({ kind: m[1].toLowerCase(), key: m[2], title: field(body, "title"), authors, authorsFull: field(body, "author"),
			year: Number((field(body, "date") || field(body, "year")).slice(0, 4)) || null,
			venue: field(body, "journaltitle") || field(body, "booktitle") || field(body, "institution") || field(body, "publisher"),
			doi: field(body, "doi"), url: field(body, "url"), file: field(body, "file"), volume: field(body, "volume"), pages: field(body, "pages") });
	}
	return out;
}
const byline = (p) => (p.authors.length > 2 ? `${p.authors[0]} et al.` : p.authors.join(" & ")) || "—";

const S = { src: null, me: "", papers: [], byKey: {}, notes: {}, loaded: false, thumbs: {}, scale: Number(store.get("ps.scale")) || 1.2, boxing: false };

async function loadStore() {
	S.papers = parseBib((await S.src.text("references.bib")) || "");
	S.byKey = Object.fromEntries(S.papers.map((p) => [p.key, p]));
	S.annotated = (await S.src.list("annotations")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
	S.loading = Promise.all(S.annotated.map((k) => notesOf(k))).then(() => (S.loaded = true));
}
async function notesOf(key) {
	if (!(key in S.notes)) {
		const t = await S.src.text(`annotations/${key}.json`);
		S.notes[key] = t ? JSON.parse(t).annotations : [];
	}
	return S.notes[key];
}
async function saveNotes(key, op, message) {   // op applies to the latest copy, so two people saving at once keep both edits
	const body = await S.src.update(`annotations/${key}.json`, (old) => JSON.stringify({ paper: key, annotations: op(old ? JSON.parse(old).annotations : []) }, null, 1) + "\n", message);
	S.notes[key] = JSON.parse(body).annotations;
	if (!S.annotated.includes(key)) S.annotated.push(key);
	if (!S.src.writable) toast("Demo: kept until you reload");
}
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, "0")).join("");
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const claimLink = (key, id) => location.origin + location.pathname + (S.src.repo !== CFG.repo && !(S.src instanceof StaticSource) ? `?repo=${S.src.repo}` : location.search) + `#/${key}/${id}`;

async function thumb(key) {   // the first-page JPEG, fetched once per visit
	if (!(key in S.thumbs)) S.thumbs[key] = S.src.blob(`thumbs/${key}.jpg`).then((b) => (b ? URL.createObjectURL(b) : null)).catch(() => null);
	return S.thumbs[key];
}
const thumbObserver = new IntersectionObserver((es) => es.forEach(async (e) => {
	if (!e.isIntersecting) return;
	thumbObserver.unobserve(e.target);
	const url = await thumb(e.target.dataset.key);
	if (url) e.target.replaceChildren(el("img", { src: url, alt: "", loading: "lazy" }));
}), { rootMargin: "400px" });

// ---- the bar ------------------------------------------------------------------------------

function bar(kind, extra = []) {
	const tab = (href, label, on) => el("a", { class: "tab" + (on ? " on" : ""), href }, label);
	$("#bar").replaceChildren(...[
		kind === "reader" ? btn("back", S.back === "#/" && S.study ? "Back to the manuscript" : "Back to the library", () => (location.hash = S.back || "#/")) : el("a", { class: "brand", href: "#/" }, icon("book"), el("span", { class: "hide-sm" }, "Paper Store")),
		kind === "reader" || !S.study ? null : tab("#/", small() ? "Paper" : "Manuscript", kind === "study"),
		kind === "reader" ? null : tab(S.study ? "#/library" : "#/", "Library", kind === "library"),
		kind === "reader" ? null : tab("#/claims", "Claims", kind === "claims"),
		...extra,
		kind === "reader" ? null : el("span", { class: "grow" }),
		kind !== "reader" && S.src?.isAdmin ? el("a", { class: "btn hide-sm", href: `https://github.com/${S.src.repo}/settings/access`, target: "_blank", rel: "noopener",
			title: "Invite people and set who can read or edit, on GitHub" }, icon("out"), "Share") : null,
		themeBtn(),
		el("span", { class: "who hide-sm", title: S.src?.repo }, !S.src?.writable ? "demo · edits not saved" : S.src.canEdit ? S.me : `${S.me} · read-only`)].filter(Boolean));
}

// ---- sign-in view -------------------------------------------------------------------------

function signinView(err) {
	$("#bar").replaceChildren(el("span", { class: "brand" }, icon("book"), "Paper Store"), el("span", { style: "flex:1" }), themeBtn());
	$("#panel").hidden = true;
	const repo = el("input", { value: store.get("ps.repo") || CFG.repo, placeholder: "owner/repository", spellcheck: "false" });
	const remember = () => { const v = repo.value.trim(); if (v && v !== CFG.repo) store.set("ps.repo", v); else store.del("ps.repo"); };
	$("#main").replaceChildren(el("div", { class: "signin" },
		el("h1", {}, "Paper Store"),
		el("p", {}, "Papers, claims and notes, read from a GitHub repository. Anyone who can open the repository can sign in."),
		err ? el("p", { style: "color:var(--bad)" }, err) : null,
		el("label", { class: "muted", style: "font-size:13px" }, "Store", repo),
		CFG.auth ? el("button", { class: "btn primary", style: "justify-content:center;padding:10px", onclick: () => { remember(); auth.login(); } }, "Sign in with GitHub") : null,
		CFG.auth ? el("button", { class: "btn", style: "justify-content:center;padding:10px;border:1px solid var(--line)", onclick: (e) => { remember(); codeSignin(e.target.closest(".signin")); } }, "Sign in with a code (from another device)") : null,
		el("details", {}, el("summary", { class: "muted", style: "font-size:13px;cursor:pointer" }, "Use an access token instead"),
			el("form", { style: "display:grid;gap:8px;margin-top:8px", onsubmit: (e) => { e.preventDefault(); remember(); auth.set(e.target.tok.value.trim()); start(); } },
				el("input", { name: "tok", type: "password", autocomplete: "off", placeholder: "fine-grained token: Contents read and write" }),
				el("button", { class: "btn", style: "justify-content:center;border:1px solid var(--line)" }, "Use token"))),
		el("p", { style: "font-size:13px" }, el("a", { href: "?demo" }, "Open the demo"), " — one open-access paper, no sign-in.")));
}

// GitHub's device flow: show a code, the person approves it at github.com/login/device on any
// device (a phone), and the token comes back here through the sign-in helper.
async function codeSignin(box) {
	const base = CFG.auth.replace(/\/$/, ""), post = (path, body) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }).then((r) => r.json());
	const out = el("div", { class: "codebox", style: "display:grid;gap:8px;text-align:center" }, el("p", { class: "muted" }, "Asking GitHub for a code…"));
	box.querySelector(".codebox")?.remove();
	box.append(out);
	let d;
	try { d = await post("/device"); } catch { d = {}; }
	if (!d.device_code) return out.replaceChildren(el("p", { style: "color:var(--bad)" }, "GitHub gave no code: " + (d.error_description || d.error || "the sign-in helper did not answer")));
	out.replaceChildren(
		el("p", {}, "On any device signed in to GitHub, open ", el("a", { href: d.verification_uri, target: "_blank", rel: "noopener" }, d.verification_uri.replace(/^https:\/\//, "")), " and enter"),
		el("div", { class: "usercode", style: "font:600 28px ui-monospace,monospace;letter-spacing:3px" }, d.user_code),
		el("p", { class: "muted", style: "font-size:13px" }, "Check it says paperstore-daniel before approving. Waiting…"));
	let wait = (d.interval || 5) * 1000;
	const until = Date.now() + (d.expires_in || 900) * 1000;
	while (Date.now() < until && out.isConnected) {
		await new Promise((r) => setTimeout(r, wait));
		let t;
		try { t = await post("/device/poll", { device_code: d.device_code }); } catch { continue; }
		if (t.access_token) { auth.set(t.access_token, t.refresh_token, t.expires_in); return start(); }
		if (t.error === "slow_down") wait = ((t.interval || wait / 1000 + 5) * 1000);
		else if (t.error !== "authorization_pending") return out.replaceChildren(el("p", { style: "color:var(--bad)" }, t.error === "access_denied" ? "The code was declined." : "Sign-in failed: " + t.error));
	}
	if (out.isConnected) out.replaceChildren(el("p", { style: "color:var(--bad)" }, "The code expired. Try again."));
}

// ---- library ------------------------------------------------------------------------------

const F = JSON.parse(sessionStorage.getItem("ps.filters") || "null") || { q: "", from: "", to: "", venue: "", only: "", sort: "new", view: "grid" };
const saveF = () => sessionStorage.setItem("ps.filters", JSON.stringify(F));

function libraryView() {
	S.back = S.study ? "#/library" : "#/";
	bar("library");
	setPanel(false);
	const years = [...new Set(S.papers.map((p) => p.year).filter(Boolean))].sort();
	const venues = [...new Set(S.papers.map((p) => p.venue).filter(Boolean))].sort((a, b) => a.localeCompare(b));
	const q = el("input", { type: "search", placeholder: "Search titles, authors, keys and venues", value: F.q, autocomplete: "off" });
	const yearSel = (v, label) => el("select", { "aria-label": label }, el("option", { value: "" }, label), ...years.map((y) => el("option", { value: y, selected: String(y) === String(v) }, y)));
	const from = yearSel(F.from, "From"), to = yearSel(F.to, "To");
	const venue = el("select", { "aria-label": "Venue", style: "max-width:220px" }, el("option", { value: "" }, "Any venue"), ...venues.map((v) => el("option", { value: v, selected: v === F.venue }, v)));
	const chip = (val, label) => el("button", { class: "chip" + (F.only === val ? " on" : ""), onclick: () => { F.only = F.only === val ? "" : val; draw(); } }, label);
	const chips = el("span", { style: "display:contents" });
	const sort = el("select", { "aria-label": "Sort" }, ...[["new", "Newest"], ["old", "Oldest"], ["author", "Author"], ["claims", "Most claims"]].map(([v, l]) => el("option", { value: v, selected: F.sort === v }, l)));
	const viewBtn = btn(F.view === "grid" ? "list" : "grid", "Grid or list", () => { F.view = F.view === "grid" ? "list" : "grid"; draw(); });
	const count = el("span"), grid = el("div");
	const draw = () => {
		Object.assign(F, { q: q.value, from: from.value, to: to.value, venue: venue.value, sort: sort.value });
		saveF();
		chips.replaceChildren(chip("claims", "With claims"), chip("nopdf", "No PDF"));
		viewBtn.replaceChildren(icon(F.view === "grid" ? "list" : "grid"));
		const terms = F.q.toLowerCase().split(/\s+/).filter(Boolean);
		const n = (p) => (S.notes[p.key] || []).length;
		let rows = S.papers.filter((p) => {
			const hay = `${p.key} ${p.title} ${p.authorsFull} ${p.year} ${p.venue} ${p.doi}`.toLowerCase();
			return terms.every((t) => hay.includes(t)) && (!F.from || p.year >= +F.from) && (!F.to || p.year <= +F.to) && (!F.venue || p.venue === F.venue)
				&& (F.only !== "claims" || S.annotated.includes(p.key)) && (F.only !== "nopdf" || !p.file);
		});
		const cmp = { new: (a, b) => (b.year || 0) - (a.year || 0), old: (a, b) => (a.year || 9999) - (b.year || 9999), author: (a, b) => byline(a).localeCompare(byline(b)), claims: (a, b) => n(b) - n(a) }[F.sort];
		rows = rows.sort((a, b) => cmp(a, b) || a.key.localeCompare(b.key));
		count.textContent = `${rows.length} of ${S.papers.length} papers`;
		grid.className = "grid" + (F.view === "list" ? " list" : "");
		grid.replaceChildren(...rows.map((p) => {
			const th = el("div", { class: "thumb", "data-key": p.key }, p.file ? null : el("div", { class: "nopdf" }, p.kind === "book" ? "Book" : "No PDF"));
			if (p.file) thumbObserver.observe(th);
			return el("a", { class: "card", href: p.file ? `#/${encodeURIComponent(p.key)}` : (p.doi ? `https://doi.org/${p.doi}` : p.url || "#/"), target: p.file ? null : "_blank", rel: p.file ? null : "noopener" },
				th,
				el("div", { class: "body" },
					el("div", { class: "t" }, p.title),
					el("div", { class: "m" }, `${byline(p)} · ${p.year || "n.d."}`),
					el("div", { class: "m" }, p.venue),
					el("div", { class: "foot" }, el("span", {}, p.key), el("span", { class: "grow", style: "flex:1" }), n(p) ? el("span", { class: "pill", title: "claims" }, icon("quote"), n(p)) : null)));
		}));
	};
	q.addEventListener("input", draw);
	[from, to, venue, sort].forEach((s) => s.addEventListener("change", draw));
	$("#main").replaceChildren(el("div", { class: "wrap" },
		el("div", { class: "search" }, icon("search"), q),
		el("div", { class: "filters" }, el("span", { class: "years" }, from, "–", to), venue, chips),
		el("div", { class: "count" }, count, el("span", { style: "display:flex;gap:6px;align-items:center" }, sort, viewBtn)),
		grid));
	draw();
	if (!S.loaded) S.loading.then(() => location.hash.replace(/^#\/?/, "") === "" && draw());
	if (!small()) q.focus({ preventScroll: true });
}

// ---- claims across papers -------------------------------------------------------------------

const C = JSON.parse(sessionStorage.getItem("ps.claims") || "null") || { q: "", tag: "", status: "", by: "", values: false, sort: "year", dir: -1 };

async function claimsView() {
	S.back = "#/claims";
	bar("claims");
	setPanel(false);
	$("#main").replaceChildren(el("div", { class: "wrap" }, el("p", { class: "muted" }, "Loading claims…")));
	await S.loading;
	const all = Object.entries(S.notes).flatMap(([key, ns]) => ns.map((n) => ({ key, n, p: S.byKey[key] || { title: key, authors: [], year: null } })));
	const tags = [...new Set(all.flatMap(({ n }) => n.tags || []))].sort();
	const people = [...new Set(all.map(({ n }) => n.creator).filter(Boolean))].sort();
	const q = el("input", { type: "search", placeholder: "Search quotes, notes, quantities and papers", value: C.q });
	const sel = (v, label, opts) => el("select", { "aria-label": label }, el("option", { value: "" }, label), ...opts.map((o) => el("option", { value: o, selected: o === v }, o)));
	const tag = sel(C.tag, "Any tag", tags), status = sel(C.status, "Any status", ["unchecked", "verified", "disputed"]), by = sel(C.by, "Anyone", people);
	const values = el("button", { class: "chip" + (C.values ? " on" : ""), onclick: () => { C.values = !C.values; values.classList.toggle("on", C.values); draw(); } }, "Numbers only");
	const out = el("div"), count = el("span");
	const draw = () => {
		Object.assign(C, { q: q.value, tag: tag.value, status: status.value, by: by.value });
		sessionStorage.setItem("ps.claims", JSON.stringify(C));
		const terms = C.q.toLowerCase().split(/\s+/).filter(Boolean);
		let rows = all.filter(({ key, n, p }) => {
			const hay = `${key} ${p.title} ${n.quote?.exact || ""} ${n.label || ""} ${n.note || ""} ${(n.tags || []).join(" ")} ${n.value?.what || ""} ${n.value?.unit || ""}`.toLowerCase();
			return terms.every((t) => hay.includes(t)) && (!C.tag || (n.tags || []).includes(C.tag)) && (!C.status || (n.status || "unchecked") === C.status)
				&& (!C.by || n.creator === C.by) && (!C.values || n.value);
		});
		count.textContent = `${rows.length} claim${rows.length === 1 ? "" : "s"}`;
		if (C.values) {   // a sortable table: quantity, value, unit, paper, year
			const keyOf = { what: (r) => r.n.value?.what || "", num: (r) => r.n.value?.number ?? -Infinity, unit: (r) => r.n.value?.unit || "", paper: (r) => r.key, year: (r) => r.p.year || 0 };
			rows = rows.sort((a, b) => { const x = keyOf[C.sort](a), y = keyOf[C.sort](b); return (x < y ? -1 : x > y ? 1 : 0) * C.dir; });
			const th = (k, label) => el("th", { onclick: () => { C.dir = C.sort === k ? -C.dir : 1; C.sort = k; draw(); } }, label + (C.sort === k ? (C.dir > 0 ? " ↑" : " ↓") : ""));
			out.replaceChildren(el("div", { class: "tablewrap" }, el("table", { class: "claims-table" },
				el("thead", {}, el("tr", {}, th("what", "Quantity"), th("num", "Value"), th("unit", "Unit"), th("paper", "Paper"), th("year", "Year"), el("th", {}, "Says"))),
				el("tbody", {}, ...rows.map(({ key, n, p }) => el("tr", { onclick: () => (location.hash = `#/${key}/${n.id}`) },
					el("td", {}, el("span", { style: "display:flex;gap:6px;align-items:center" }, el("span", { class: "dot " + (n.status || "unchecked") }), n.value.what || "—")),
					el("td", { class: "num" }, n.value.number), el("td", {}, n.value.unit || ""),
					el("td", {}, byline(p)), el("td", {}, p.year || ""),
					el("td", { class: "q" }, n.quote?.exact || n.label || "[box]")))))));
		} else {
			rows = rows.sort((a, b) => (b.p.year || 0) - (a.p.year || 0) || a.key.localeCompare(b.key) || a.n.page - b.n.page);
			out.replaceChildren(...rows.map(({ key, n, p }) => claimCard(key, n, { paper: p })));
			if (!rows.length) out.append(el("p", { class: "empty" }, all.length ? "No claims match." : "No claims yet. Open a paper, select a sentence and press Claim, or use paperstore annotate."));
		}
	};
	q.addEventListener("input", draw);
	[tag, status, by].forEach((s) => s.addEventListener("change", draw));
	$("#main").replaceChildren(el("div", { class: "wrap", style: "max-width:980px" },
		el("div", { class: "search" }, icon("search"), q),
		el("div", { class: "filters" }, tag, status, by, values),
		el("div", { class: "count" }, count), out));
	draw();
}

// ---- a claim card -------------------------------------------------------------------------

function claimCard(key, n, opt = {}) {
	const st = n.status || "unchecked";
	const what = n.quote?.exact || (n.kind === "area" ? (n.label || "Box on the page") : "");
	const card = el("div", { class: `claim ${st} ${n.kind === "area" ? "area" : ""}`, "data-id": n.id,
		onclick: (e) => { if (e.target.closest("button, textarea, input, a")) return; opt.paper ? (location.hash = `#/${key}/${n.id}`) : selectClaim(n.id, true); } },
		el("div", { class: "head" },
			el("span", { class: "dot " + st, title: st }),
			opt.paper ? el("span", { style: "font-weight:600;color:var(--ink)" }, `${byline(opt.paper)} ${opt.paper.year || ""}`) : null,
			el("span", {}, `p.${n.page}`), el("span", { class: "grow" }), el("span", {}, n.creator || "")),
		el("blockquote", {}, what),
		n.value ? el("div", { class: "value" }, n.value.what ? `${n.value.what} ` : "", el("span", { class: "num" }, `${n.value.number}${n.value.unit ? " " + n.value.unit : ""}`)) : null,
		n.note ? el("div", { class: "note" }, n.note) : null,
		n.tags?.length ? el("div", { class: "tags" }, ...n.tags.map((t) => el("span", { class: "tag" }, t))) : null);
	if (!opt.paper && !S.src.canEdit) {   // read-only: the link alone
		card.append(el("div", { class: "acts" }, el("span", { class: "grow", style: "flex:1" }),
			btn("link", "Copy a link to this claim", async () => { try { await navigator.clipboard.writeText(claimLink(key, n.id)); toast("Link copied"); } catch { prompt("Link to this claim", claimLink(key, n.id)); } })));
	} else if (!opt.paper) {   // in the reader: status, edit, link, delete
		const seg = el("div", { class: "seg", role: "group", "aria-label": "Status" }, ...["unchecked", "verified", "disputed"].map((s) =>
			el("button", { class: s === st ? "on" : "", onclick: () => s !== st && edit(key, n.id, { status: s }, `mark ${s}`) }, s === "unchecked" ? "Unchecked" : s === "verified" ? "Verified" : "Disputed")));
		card.append(el("div", { class: "acts" }, seg,
			btn("edit", "Edit note and tags", () => editInline(card, key, n)),
			btn("link", "Copy a link to this claim", async () => { try { await navigator.clipboard.writeText(claimLink(key, n.id)); toast("Link copied"); } catch { prompt("Link to this claim", claimLink(key, n.id)); } }),
			btn("trash", "Delete", () => confirm("Delete this claim?") && removeNote(key, n.id))));
	}
	return card;
}

function editInline(card, key, n) {
	$(".edit", card)?.remove();
	const note = el("textarea", { rows: 3, placeholder: "Note" }); note.value = n.note || "";
	const tags = el("input", { value: (n.tags || []).join(" "), placeholder: "Tags, space separated" });
	card.append(el("div", { class: "edit" }, note, tags, el("div", { class: "row" },
		el("button", { class: "btn", onclick: () => $(".edit", card).remove() }, "Cancel"),
		el("button", { class: "btn primary", onclick: () => edit(key, n.id, { note: note.value.trim(), tags: tags.value.split(/\s+/).filter(Boolean) }, "edit note") }, "Save"))));
	note.focus();
}
async function edit(key, id, patch, what) {
	try { await saveNotes(key, (list) => list.map((x) => (x.id === id ? { ...x, ...patch, modified: nowIso() } : x)), `${key}: ${what} (${id})`); refreshReader(id); }
	catch (e) { toast(e.message, 5000); }
}
async function removeNote(key, id) {
	try { await saveNotes(key, (list) => list.filter((x) => x.id !== id), `${key}: delete claim ${id}`); refreshReader(); }
	catch (e) { toast(e.message, 5000); }
}

// ---- the reader ---------------------------------------------------------------------------

let R = null;   // {key, paper, doc, pages: [{div, w, h, done}], scale, tab, sel}

function setPanel(on) {
	$("#panel").hidden = !on;
	document.body.classList.toggle("paneled", on);
}

async function readerView(key, claimId) {
	const paper = S.byKey[key];
	if (!paper) return libraryView();
	if (!R || R.key !== key) {
		R = { key, paper, tab: "claims", panel: !small() || !!claimId };
		readerBar();
		setPanel(R.panel);
		$("#main").replaceChildren(el("div", { class: "wrap muted" }, `Opening ${paper.title}…`));
		const [data] = await Promise.all([S.src.bytes(paper.file || key + ".pdf"), notesOf(key)]);
		if (R?.key !== key) return;
		R.doc = await pdfjs.getDocument({ data }).promise;
		await layout();
		drawPanel();
	}
	if (claimId) { R.tab = "claims"; if (!R.panel) togglePanel(true); selectClaim(claimId, true); }
}

function readerBar() {
	const page = el("input", { inputmode: "numeric", value: "1", "aria-label": "Page", onchange: (e) => goPage(Number(e.target.value)) });
	R.pageInput = page;
	const find = el("input", { type: "search", placeholder: "Find in paper", "aria-label": "Find in paper" });
	const findN = el("span", { class: "n" });
	R.find = { input: find, n: findN, hits: [], i: -1 };
	find.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? stepFind(-1) : (find.value !== R.find.q ? runFind(find.value) : stepFind(1)); } if (e.key === "Escape") clearFind(); });
	const findbox = el("span", { class: "findbox", hidden: small() || null }, find, findN, btn("up", "Previous match", () => stepFind(-1)), btn("down", "Next match", () => stepFind(1)));
	const p = R.paper;
	bar(R.study ? "study" : "reader", [
		R.study ? studyPicker() : el("span", { class: "title", title: p.title }, el("span", {}, `${byline(p)} ${p.year || ""}`), el("span", { class: "muted hide-sm" }, ` — ${p.title}`)),
		el("span", { class: "pageno hide-sm" }, page, el("span", { class: "of" }, "/ …")),
		findbox,
		small() ? btn("search", "Find in paper", () => { findbox.hidden = !findbox.hidden; if (!findbox.hidden) find.focus(); }) : null,
		btn("minus", "Zoom out", () => zoom(1 / 1.15), { cls: "hide-sm" }), btn("plus", "Zoom in", () => zoom(1.15), { cls: "hide-sm" }),
		R.boxBtn = S.src.canEdit && !R.study ? btn("box", "Box a figure or table (B)", () => setBoxing(!S.boxing), { label: small() ? null : "Box" }) : null,
		R.panelBtn = btn("panel", R.study ? "Facts, claims and checks" : "Claims and details", () => togglePanel(), { cls: R.panel ? "on" : "" }),
	].filter(Boolean));
}

function togglePanel(on = !R.panel) {
	R.panel = on;
	setPanel(on);
	R.panelBtn?.classList.toggle("on", on);
	if (!small()) relayout();
}
async function relayout() {
	if (!R?.doc) return;
	const keep = R.pages.length ? currentPage() : 1;
	await layout();
	goPage(keep, false);
}

async function layout() {
	const box = el("div", { id: "pages" });
	$("#main").replaceChildren(box);
	R.observer?.disconnect();
	R.observer = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && renderPage(Number(e.target.dataset.n))), { rootMargin: "1200px 0px" });
	R.pages = [];
	const first = await R.doc.getPage(1);
	const room = document.documentElement.clientWidth - (small() ? 4 : (R.panel ? 380 : 0) + 48);   // clientWidth: no scrollbar
	const base = first.getViewport({ scale: 1 }).width;
	R.scale = small() ? room / base * Math.min(S.scale / 1.2, 3) : Math.min(S.scale, room / base);
	for (let n = 1; n <= R.doc.numPages; n++) {
		const vp = (n === 1 ? first : await R.doc.getPage(n)).getViewport({ scale: R.scale });
		const div = el("div", { class: "page", "data-n": n, style: `width:${vp.width}px;height:${vp.height}px;--scale-factor:${R.scale}` });
		box.append(div);
		R.pages[n] = { div, w: vp.width, h: vp.height, done: false };
		R.observer.observe(div);
		if (!R.study) boxDrawing(div, n);
	}
	$(".pageno .of")?.replaceChildren(`/ ${R.doc.numPages}`);
	if (R.study) drawLinks(); else drawHighlights();
}

async function renderPage(n) {
	const P = R.pages[n];
	if (!P || P.done) return;
	P.done = true;
	const page = await R.doc.getPage(n), vp = page.getViewport({ scale: R.scale }), ratio = Math.min(window.devicePixelRatio || 1, 2);
	const canvas = el("canvas", { width: Math.floor(vp.width * ratio), height: Math.floor(vp.height * ratio) });
	P.div.prepend(canvas);
	await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null }).promise;
	const tl = el("div", { class: "textLayer" });
	P.div.append(tl);
	await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp }).render();
	if (R.find?.q) markFindOn(n);
}

function drawHighlights() {
	$$(".hl").forEach((h) => h.remove());
	for (const n of S.notes[R.key] || []) {
		const P = R.pages[n.page];
		if (!P) continue;
		for (const [x0, y0, x1, y1] of n.rects || []) {
			P.div.append(el("div", { class: `hl ${n.status || "unchecked"} ${n.kind === "area" ? "area" : ""} ${R.sel === n.id ? "sel" : ""}`, "data-id": n.id, title: n.note || n.quote?.exact || "",
				style: `left:${x0 * 100}%;top:${y0 * 100}%;width:${(x1 - x0) * 100}%;height:${(y1 - y0) * 100}%`,
				onclick: () => { if (!R.panel) togglePanel(true); R.tab = "claims"; selectClaim(n.id, false); } }));
		}
	}
}

const currentPage = () => { const mid = scrollY + innerHeight / 3; let best = 1; for (let n = 1; n < R.pages.length; n++) if (R.pages[n].div.offsetTop <= mid) best = n; return best; };
function goPage(n, smooth = true) {
	n = Math.max(1, Math.min(R.doc.numPages, n || 1));
	scrollTo({ top: R.pages[n].div.offsetTop - 64, behavior: smooth ? "smooth" : "auto" });
}
addEventListener("scroll", () => { if (R?.pageInput && document.activeElement !== R.pageInput && R.pages.length) R.pageInput.value = currentPage(); }, { passive: true });

function selectClaim(id, scroll) {
	R.sel = id;
	drawPanel();
	$$(".hl").forEach((h) => h.classList.toggle("sel", h.dataset.id === id));
	const n = (S.notes[R.key] || []).find((x) => x.id === id);
	if (!n) return;
	$(`#panel .claim[data-id="${id}"]`)?.scrollIntoView({ block: "nearest" });
	if (scroll) {
		const P = R.pages[n.page];
		const y = P.div.offsetTop + (n.rects?.[0]?.[1] || 0) * P.h;
		scrollTo({ top: Math.max(0, y - (small() ? 90 : innerHeight / 3)), behavior: "smooth" });
	}
	setTimeout(() => $$(`.hl[data-id="${id}"]`).forEach((h) => { h.classList.remove("flash"); void h.offsetWidth; h.classList.add("flash"); }), scroll ? 350 : 0);
	if (location.hash !== `#/${R.key}/${id}`) history.replaceState(null, "", `#/${R.key}/${id}`);
}

function refreshReader(selId) {
	if (!R) return;
	if (selId) R.sel = selId;
	drawPanel();
	drawHighlights();
}

function drawPanel() {
	if (!R) return;
	if (R.study) return drawStudyPanel();
	const p = R.paper, notes = (S.notes[R.key] || []).slice().sort((a, b) => a.page - b.page || (a.rects?.[0]?.[1] || 0) - (b.rects?.[0]?.[1] || 0));
	const tab = (id, label) => el("button", { class: "ptab" + (R.tab === id ? " on" : ""), onclick: () => { R.tab = id; drawPanel(); } }, label);
	let body;
	if (R.tab === "details") {
		const row = (k, v) => v ? [el("dt", {}, k), el("dd", {}, v)] : [];
		body = el("div", { class: "details" },
			el("h2", {}, p.title),
			el("div", { class: "muted", style: "font-size:14px" }, p.authorsFull.replace(/ and /g, "; ")),
			el("dl", {}, ...row("Year", p.year), ...row("Venue", p.venue), ...row("Volume", p.volume), ...row("Pages", p.pages),
				...row("DOI", p.doi ? el("a", { href: `https://doi.org/${p.doi}`, target: "_blank", rel: "noopener" }, p.doi) : null),
				...row("Key", el("span", {}, p.key, " ", btn("copy", "Copy the key", async () => { try { await navigator.clipboard.writeText(p.key); toast("Key copied"); } catch {} }))),
				...row("Length", R.doc ? `${R.doc.numPages} pages` : null)));
	} else {
		body = el("div", {}, notes.length ? notes.map((n) => { const c = claimCard(R.key, n); if (n.id === R.sel) c.classList.add("sel"); return c; })
			: el("p", { class: "empty" }, "No claims on this paper yet.", S.src.canEdit ? [el("br"), "Select a sentence and press ", el("b", {}, "Claim"), ", or press ", el("b", {}, "Box"), " to mark a figure or table."] : null));
	}
	const grip = el("div", { class: "grip", onclick: () => $("#panel").classList.toggle("tall") });
	$("#panel").replaceChildren(grip, el("div", { class: "ptabs" }, tab("claims", `Claims${notes.length ? " · " + notes.length : ""}`), tab("details", "Details"), el("span", { class: "grow" }),
		small() ? btn("close", "Close", () => togglePanel(false)) : null), el("div", { class: "pbody" }, body));
}

// ---- find in the paper --------------------------------------------------------------------

const fold = (s) => s.normalize("NFKC").toLowerCase().replace(/[‐-—−]/g, "-").replace(/\s+/g, " ");
async function runFind(q) {
	clearFind(true);
	R.find.q = q.trim();
	if (!R.find.q) return;
	const want = fold(R.find.q);
	for (let n = 1; n <= R.doc.numPages; n++) {
		const tc = await (await R.doc.getPage(n)).getTextContent();
		const text = fold(tc.items.map((i) => i.str + (i.hasEOL ? " " : "")).join(""));
		let i = -1, k = 0;
		while ((i = text.indexOf(want, i + 1)) !== -1) R.find.hits.push({ page: n, k: k++ });
	}
	for (let n = 1; n < R.pages.length; n++) if (R.pages[n].done) markFindOn(n);
	R.find.n.textContent = R.find.hits.length ? `0/${R.find.hits.length}` : "none";
	if (R.find.hits.length) stepFind(1);
}
function markFindOn(n) {   // marks the text-layer spans that hold the term (a term split across spans is still counted, not marked)
	const want = fold(R.find.q);
	$$(".textLayer span", R.pages[n].div).forEach((s) => s.classList.toggle("findhit", fold(s.textContent).includes(want)));
}
function stepFind(d) {
	const F = R.find;
	if (!F.hits.length) return;
	F.i = (F.i + d + F.hits.length) % F.hits.length;
	const h = F.hits[F.i];
	F.n.textContent = `${F.i + 1}/${F.hits.length}`;
	goPage(h.page);
	setTimeout(() => { $$(".findhit.cur").forEach((s) => s.classList.remove("cur")); const spans = $$(".findhit", R.pages[h.page].div); const s = spans[Math.min(h.k, spans.length - 1)]; if (s) { s.classList.add("cur"); s.scrollIntoView({ block: "center", behavior: "smooth" }); } }, 500);
}
function clearFind(keepInput) {
	$$(".findhit").forEach((s) => s.classList.remove("findhit", "cur"));
	Object.assign(R.find, { hits: [], i: -1, q: "" });
	R.find.n.textContent = "";
	if (!keepInput) R.find.input.value = "";
}

// ---- making claims ------------------------------------------------------------------------

function selectionTarget() {
	const sel = getSelection();
	if (!sel || sel.isCollapsed || !R || !sel.rangeCount) return null;
	const range = sel.getRangeAt(0).cloneRange();   // widened to whole words: "than", not "han"
	const word = /[\p{L}\p{N}]/u;
	if (range.startContainer.nodeType === 3) { const t = range.startContainer.data; let i = range.startOffset; while (i > 0 && word.test(t[i - 1])) i--; range.setStart(range.startContainer, i); }
	if (range.endContainer.nodeType === 3) { const t = range.endContainer.data; let i = range.endOffset; while (i < t.length && word.test(t[i])) i++; range.setEnd(range.endContainer, i); }
	const node = range.commonAncestorContainer;
	const pageDiv = (node.nodeType === 1 ? node : node.parentElement)?.closest(".page");
	if (!pageDiv) return null;
	const n = Number(pageDiv.dataset.n), box = pageDiv.getBoundingClientRect(), lines = [];
	for (const r of range.getClientRects()) {
		if (r.width < 1 || r.height < 1) continue;
		const f = [(r.left - box.left) / box.width, (r.top - box.top) / box.height, (r.right - box.left) / box.width, (r.bottom - box.top) / box.height];
		const same = lines.find((l) => Math.abs((l[1] + l[3]) / 2 - (f[1] + f[3]) / 2) < (f[3] - f[1]) / 2);
		if (same) { same[0] = Math.min(same[0], f[0]); same[2] = Math.max(same[2], f[2]); same[1] = Math.min(same[1], f[1]); same[3] = Math.max(same[3], f[3]); }
		else lines.push(f);
	}
	const text = range.toString().replace(/\s+/g, " ").trim();
	if (!text || !lines.length) return null;
	return { kind: "quote", page: n, text, rects: lines.map((l) => l.map((x) => Math.round(Math.min(1, Math.max(0, x)) * 1e4) / 1e4)), at: sel.getRangeAt(0).getBoundingClientRect() };
}

function placePop() {
	const t = selectionTarget(), pop = $("#pop");
	if (!t) { pop.hidden = true; return; }
	pop.replaceChildren(
		S.src.canEdit && !R.study ? el("button", { class: "btn", onpointerdown: (e) => e.preventDefault(), onclick: () => { const t2 = selectionTarget(); if (t2) compose(t2); } }, icon("quote"), "Claim") : "",
		el("button", { class: "btn", onpointerdown: (e) => e.preventDefault(), onclick: async () => { try { await navigator.clipboard.writeText(t.text); toast("Copied"); } catch {} pop.hidden = true; } }, icon("copy"), "Copy"));
	pop.hidden = false;
	const w = pop.offsetWidth, below = t.at.bottom + 10, above = t.at.top - pop.offsetHeight - 10;
	pop.style.left = `${Math.min(innerWidth - w - 8, Math.max(8, t.at.left + t.at.width / 2 - w / 2))}px`;
	// on phones the system's own selection menu sits above the text, so ours goes below
	pop.style.top = `${small() || above < 60 ? Math.min(below, innerHeight - 60) : above}px`;
}

async function compose(target) {
	$("#pop").hidden = true;
	const d = $("#composer");
	const note = el("textarea", { rows: 3, placeholder: "What it says, why it matters, what to check" });
	const tags = el("input", { placeholder: "e.g. timing leaderboard" });
	const num = el("input", { inputmode: "decimal", placeholder: "214" }), unit = el("input", { placeholder: "ps" }), what = el("input", { placeholder: "CTR" });
	const guess = target.text?.match(/(-?\d+(?:\.\d+)?)\s*(ps|ns|mm|cm|%|keV|MeV|kcps\/MBq|cps\/kBq|MBq|kBq)\b/);
	if (guess) { num.value = guess[1]; unit.value = guess[2]; }
	const form = el("form", { class: "compose", method: "dialog" },
		el("h3", {}, target.kind === "area" ? `Box on page ${target.page}` : `Claim on page ${target.page}`),
		target.kind === "area" ? null : el("blockquote", {}, target.text),
		el("label", {}, "Note", note), el("label", {}, "Tags", tags),
		el("details", { open: guess ? true : null }, el("summary", {}, "A number this reports"), el("div", { class: "row", style: "margin-top:8px" },
			el("label", {}, "Value", num), el("label", {}, "Unit", unit), el("label", {}, "Quantity", what))),
		el("div", { class: "acts" }, el("button", { class: "btn", value: "cancel", formnovalidate: true }, "Cancel"), el("button", { class: "btn primary", value: "save" }, "Save")));
	d.replaceChildren(form);
	d.showModal();
	if (!small()) note.focus();
	const v = await new Promise((res) => d.addEventListener("close", () => res(d.returnValue), { once: true }));
	if (v !== "save") return;
	const n = { id: newId(), created: nowIso(), creator: S.me, kind: target.kind, page: target.page,
		...(target.kind === "quote" ? { quote: { exact: target.text } } : {}),
		rects: target.rects, note: note.value.trim(), tags: tags.value.split(/\s+/).filter(Boolean), status: "unchecked" };
	const x = parseFloat(num.value);
	if (!Number.isNaN(x)) n.value = { number: x, ...(unit.value ? { unit: unit.value.trim() } : {}), ...(what.value ? { what: what.value.trim() } : {}) };
	try {
		await saveNotes(R.key, (list) => [...list, n], `${R.key}: claim p.${n.page} (${n.id})`);
		getSelection()?.removeAllRanges();
		R.tab = "claims";
		if (!R.panel) togglePanel(true);
		refreshReader(n.id);
		selectClaim(n.id, false);
		if (S.src.writable) toast("Saved");
	} catch (e) { toast(e.message, 5000); }
}

function boxDrawing(div, n) {
	let start = null, box = null;
	const at = (e) => { const r = div.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
	div.addEventListener("pointerdown", (e) => {
		if (!S.boxing) return;
		e.preventDefault();
		start = at(e);
		box = el("div", { class: "drawing" }); div.append(box);
		div.setPointerCapture(e.pointerId);
	});
	div.addEventListener("pointermove", (e) => {
		if (!start) return;
		const [x, y] = at(e);
		Object.assign(box.style, { left: `${Math.min(x, start[0]) * 100}%`, top: `${Math.min(y, start[1]) * 100}%`, width: `${Math.abs(x - start[0]) * 100}%`, height: `${Math.abs(y - start[1]) * 100}%` });
	});
	div.addEventListener("pointerup", (e) => {
		if (!start) return;
		const [x, y] = at(e);
		const rect = [Math.min(x, start[0]), Math.min(y, start[1]), Math.max(x, start[0]), Math.max(y, start[1])].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 1e4) / 1e4);
		start = null; box.remove();
		if (rect[2] - rect[0] > 0.01 && rect[3] - rect[1] > 0.005) { setBoxing(false); compose({ kind: "area", page: n, rects: [rect] }); }
	});
}
function setBoxing(on) {
	S.boxing = on;
	R?.boxBtn?.classList.toggle("on", on);
	document.body.classList.toggle("boxing", on);
	if (on) toast(small() ? "Drag over the figure" : "Drag a box over the figure or table · Esc to stop");
}
async function zoom(f) {
	if (!R) return;
	S.scale = Math.min(4, Math.max(0.5, S.scale * f));
	store.set("ps.scale", S.scale);
	await relayout();
}

// ---- a study's manuscript (?study=owner/repo) ----------------------------------------------
// A repository laid out like the study template: step3_outputs/sources.py writes
// report/sources-<paper>.json (every \fact with the code and the files behind it, every
// \claim with the annotations it names), and its CI publishes the draft PDF, in which each
// fact and claim is a link, to the `drafts` branch. This shows that PDF with every link
// opening its source in the panel, and checks each claim against this store as it is now.

const INSTALL = CFG.install || "https://github.com/apps/paperstore-daniel/installations/new";   // where the app is given more repositories

async function loadStudy() {
	const st = S.study;
	const r = await st.src.req("");
	if (!r.ok) throw Object.assign(new Error(`${S.me} cannot open ${st.repo}` + (r.status === 404 ? "" : ` (GitHub said ${r.status})`)), { install: r.status === 404 });
	st.papers = (await st.src.list("report")).map((f) => /^sources-(.+)\.json$/.exec(f)?.[1]).filter(Boolean).sort();
	if (!st.papers.length) throw new Error(`${st.repo} has no report/sources-<paper>.json yet: run step3_outputs/sources.py there and push`);
	st.paper = st.papers.includes(params.get("paper")) ? params.get("paper") : st.papers[0];
	const sheets = await Promise.all(st.papers.map((p) => st.src.text(`report/sources-${p}.json`).then((t) => JSON.parse(t)).catch(() => ({ paper: p }))));
	st.titles = Object.fromEntries(sheets.map((d, i) => [st.papers[i], d.title || ""]));
	st.data = sheets[st.papers.indexOf(st.paper)];
	if (!st.data.facts) throw new Error(`report/sources-${st.paper}.json could not be read`);
	st.bySlug = Object.fromEntries(Object.entries(st.data.facts).map(([name, f]) => [f.slug, name]));
}

function studyError(e) {
	$("#main").replaceChildren(el("div", { class: "wrap" }, el("p", {}, "Could not open the study: " + e.message + "."),
		e.install ? el("p", { class: "muted" }, "If you can open it on GitHub, the Paper Store app is not allowed to read it yet: ",
			el("a", { href: INSTALL, target: "_blank", rel: "noopener" }, "add the repository to the app"), ", then reload.") : null,
		el("a", { href: "#/library" }, "Open the library instead")));
}

function studyPicker() {
	// each paper in the repository by its title; choosing one reloads with ?paper=, so a link names it
	const st = S.study, name = st.repo.split("/").pop(), label = (p) => plainTitle(st.titles[p]) || p;
	if (st.papers.length < 2) return small() ? null : el("span", { class: "title", title: `${st.repo}: ${label(st.paper)}` }, el("span", {}, st.paper), el("span", { class: "muted" }, ` — ${label(st.paper)}`));
	return el("select", { class: "paperpick", "aria-label": "Which paper", title: `The papers in ${name}`,
		onchange: (e) => { const p = new URLSearchParams(location.search); p.set("paper", e.target.value); location.href = location.pathname + "?" + p + "#/"; } },
		...st.papers.map((p) => el("option", { value: p, selected: p === st.paper }, small() ? p : `${p}: ${label(p)}`)));
}

async function studyView(kind, ref) {
	S.back = "#/";
	const st = S.study;
	if (!st.data) {
		bar("study");
		setPanel(false);
		$("#main").replaceChildren(el("div", { class: "wrap muted" }, `Opening ${st.repo}…`));
		try { await Promise.all([loadStudy(), S.loading]); } catch (e) { return studyError(e); }
	}
	if (S.studyR) {   // back from a paper: the same draft, where it was
		if (R !== S.studyR) { R = S.studyR; readerBar(); setPanel(R.panel); if (R.doc) { await layout(); scrollTo(0, R.y || 0); } drawPanel(); }
	} else {
		R = S.studyR = { study: true, key: "", paper: {}, tab: "facts", panel: !small() || !!kind, pages: [], links: [] };
		readerBar();
		setPanel(R.panel);
		drawPanel();
		$("#main").replaceChildren(el("div", { class: "wrap muted" }, `Opening the draft of ${st.paper}…`));
		try { R.doc = await pdfjs.getDocument({ data: await st.drafts.bytes(st.data.draft) }).promise; }
		catch (e) {
			if (R !== S.studyR) return;
			$("#main").replaceChildren(el("div", { class: "wrap" },
				el("p", {}, e.status === 404 ? `No draft PDF of ${st.paper} yet: ${st.data.draft} is not on the repository's drafts branch.` : "Could not open the draft: " + e.message),
				el("p", { class: "muted" }, "The study's CI builds the draft (every \\fact and \\claim marked and linked) on each push to main and publishes it there. Until then its facts, claims and checks are in the panel.",
					small() ? [" ", el("button", { class: "btn", onclick: () => togglePanel(true) }, "Open the panel")] : null)));
			return;
		}
		R.links = await scanLinks();
		if (R !== S.studyR) return;
		await layout();
		drawPanel();
	}
	if (kind) pick(kind, ref, true);
}

async function scanLinks() {   // every link in the draft: a fact, a claim, a place in the paper, or a web address
	const out = [], st = S.study;
	for (let n = 1; n <= R.doc.numPages; n++) {
		const page = await R.doc.getPage(n), vp = page.getViewport({ scale: 1 });
		for (const a of await page.getAnnotations()) {
			if (a.subtype !== "Link") continue;
			const [x0, y0, x1, y1] = vp.convertToViewportRectangle(a.rect);
			const rect = [Math.min(x0, x1) / vp.width, Math.min(y0, y1) / vp.height, Math.max(x0, x1) / vp.width, Math.max(y0, y1) / vp.height];
			const f = a.url && /\/report\/sources-[^#]*\.md#(.+)$/.exec(a.url), c = a.url && /#\/([^/#?]+)\/([^/#?]+)$/.exec(a.url);
			if (f && st.bySlug[decodeURIComponent(f[1])]) out.push({ page: n, rect, kind: "fact", ref: st.bySlug[decodeURIComponent(f[1])] });
			else if (c) out.push({ page: n, rect, kind: "claim", ref: `${decodeURIComponent(c[1])}/${decodeURIComponent(c[2])}` });
			else if (a.url) out.push({ page: n, rect, kind: "link", ref: a.url });
			else if (a.dest) out.push({ page: n, rect, kind: "dest", ref: a.dest, pdf: a.rect });
			if (c) out.at(-1).pdf = a.rect;
		}
		const claims = out.filter((L) => L.page === n && L.kind === "claim");
		if (claims.length) {   // each claim's sentence, highlighted in the text as the paper store highlights a quote
			const text = pageStream(await page.getTextContent());
			for (const L of claims) L.lines = sentenceLines(text, L, vp);
		}
	}
	return out;
}

// the page's text as lowercase letters and digits, each knowing which character of which text item
// it came from: so a sentence is found whatever the PDF did to its spaces, hyphens and ligatures
function pageStream(tc) {
	const chars = [], at = [];
	tc.items.forEach((it, i) => {
		for (let k = 0; k < (it.str || "").length; k++)
			for (const ch of it.str[k].normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "")) { chars.push(ch); at.push([i, k]); }
	});
	return { text: chars.join(""), at, items: tc.items };
}

// a claim's sentence as the PDF prints its words: facts filled in; math, citations and references
// cut out (the PDF prints them differently), leaving the runs of plain words to look for
function proseRuns(u) {
	const s = u.sentence.replace(/\\fact\{([^}]*)\}/g, (_, n) => S.study.data.facts[n]?.value ?? "")
		.replace(/\$[^$]*\$/g, "|").replace(/\\(?:claim\*?|cite[a-z]*\*?|ref|eqref|autoref|cref|Cref)(?:\[[^\]]*\])*\{[^}]*\}/g, "|")
		.replace(/\\[A-Za-z]+/g, " ").replace(/\\./g, " ");
	return s.split("|").map((x) => x.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "")).filter((x) => x.length >= 8);
}

function sentenceLines(T, L, vp) {
	const u = S.study.data.claims[useOf(L.ref)];
	const runs = u ? proseRuns(u) : [];
	if (!runs.length) return null;
	// where the mark is in the text: after the last character left of it on its line
	const [mx, my0, , my1] = L.pdf, charX = (j) => { const [i, k] = T.at[j], it = T.items[i]; return it.transform[4] + it.width * k / it.str.length; };
	let m = -1;
	for (let j = 0; j < T.at.length; j++) {
		const it = T.items[T.at[j][0]], y = it.transform[5];
		if (y > my0 - 6 && y < my1 + 1 && charX(j) < mx + 1) m = j;   // the mark's own line only: the next is ~12 pt lower
	}
	if (m < 0) return null;
	let head = runs[0].slice(0, 30), start = T.text.lastIndexOf(head, m);
	if (start < 0) { head = runs[0].slice(0, 14); start = T.text.lastIndexOf(head, m); }
	if (start < 0 || m - start > 1500) return null;   // begins on the page before, or not found: the mark alone
	const tail = runs.at(-1).slice(-24), t = T.text.indexOf(tail, start);
	const end = t >= 0 && t - start < 2000 ? Math.max(t + tail.length, m + 1) : m + 1;
	// the characters' extent on each line, as one band at the height of the line's body text (a
	// superscript or a subscript joins its line rather than making a box of its own)
	const spans = new Map();
	for (let j = start; j < end; j++) { const [i, k] = T.at[j], s = spans.get(i); if (s) { s[0] = Math.min(s[0], k); s[1] = Math.max(s[1], k); } else spans.set(i, [k, k]); }
	const lines = [];
	for (const [i, [a, b]] of spans) {
		const it = T.items[i], [, , c, d, x, y] = it.transform, fs = Math.hypot(c, d) || it.height || 10, w = it.width / it.str.length;
		let line = lines.find((l) => Math.abs(l.y - y) < Math.max(l.fs, fs) * 0.6);
		if (!line) lines.push(line = { y, fs, x0: Infinity, x1: -Infinity });
		if (fs > line.fs) { line.fs = fs; line.y = y; }
		line.x0 = Math.min(line.x0, x + w * a); line.x1 = Math.max(line.x1, x + w * (b + 1));
	}
	return lines.map((l) => {
		const [X0, Y0, X1, Y1] = vp.convertToViewportRectangle([l.x0, l.y - 0.24 * l.fs, l.x1, l.y + 0.76 * l.fs]);
		return [Math.min(X0, X1) / vp.width, Math.min(Y0, Y1) / vp.height, Math.max(X0, X1) / vp.width, Math.max(Y0, Y1) / vp.height];
	});
}

const useOf = (ref) => S.study.data.claims.findIndex((u) => u.refs.includes(ref));
const linkOn = (L) => R.sel && L.kind === R.sel.kind && (L.kind === "fact" ? L.ref === R.sel.ref : S.study.data.claims[R.sel.use]?.refs.includes(L.ref));

function drawLinks() {
	$$(".srclink, .srchl").forEach((h) => h.remove());
	for (const L of R.links) {
		const P = R.pages[L.page];
		if (!P) continue;
		const pad = L.kind === "claim" ? 0.005 : 0, [x0, y0, x1, y1] = L.rect;
		// a claim's one mark stands for every annotation it names: red if any fails, green when all are verified
		const u = L.kind === "claim" ? S.study.data.claims[useOf(L.ref)] : null, sts = u ? u.refs.map((r) => claimState(r, u)) : L.kind === "claim" ? [claimState(L.ref)] : [];
		const look = sts.some((x) => x.problem) ? " bad" : sts.length && sts.every((x) => x.n?.status === "verified") ? " verified" : "";
		for (const [a, b, c, d] of L.lines || [])   // the sentence itself, highlighted
			P.div.append(el("div", { class: `srchl${look}${linkOn(L) ? " sel" : ""}`, "data-kind": "claim", "data-ref": L.ref, title: `${L.ref}: the passage it rests on`,
				style: `left:${a * 100}%;top:${b * 100}%;width:${(c - a) * 100}%;height:${(d - b) * 100}%`, onclick: () => pick("claim", L.ref, false) }));
		P.div.append(el("a", { class: `srclink k-${L.kind}${look}${linkOn(L) ? " sel" : ""}`,
			"data-kind": L.kind, "data-ref": typeof L.ref === "string" ? L.ref : "",
			title: L.kind === "fact" ? `${L.ref}: where it comes from` : L.kind === "claim" ? `${L.ref}: the passage it rests on` : L.kind === "link" ? L.ref : null,
			href: L.kind === "link" ? L.ref : null, target: L.kind === "link" ? "_blank" : null, rel: L.kind === "link" ? "noopener" : null,
			style: `left:${(x0 - pad) * 100}%;top:${(y0 - pad) * 100}%;width:${(x1 - x0 + 2 * pad) * 100}%;height:${(y1 - y0 + 2 * pad) * 100}%`,
			onclick: (e) => { if (L.kind === "link") return; e.preventDefault(); if (L.kind === "dest") goDest(L.ref); else pick(L.kind, L.ref, false); } }));
	}
}

async function goDest(dest) {   // a \ref or a citation: the place in this PDF it points to
	const d = typeof dest === "string" ? await R.doc.getDestination(dest) : dest;
	if (!d) return;
	const n = (await R.doc.getPageIndex(d[0])) + 1, P = R.pages[n];
	if (!P) return;
	let y = 0;
	if (d[1]?.name === "XYZ" && d[3] != null) y = (await R.doc.getPage(n)).getViewport({ scale: R.scale }).convertToViewportPoint(0, d[3])[1];
	scrollTo({ top: P.div.offsetTop + y - 80, behavior: "smooth" });
}

function pick(kind, ref, scroll) {   // a fact or a claim, in the panel and in the PDF
	R.sel = kind === "fact" ? { kind, ref } : { kind, ref, use: useOf(ref) };
	R.tab = kind === "fact" ? "facts" : "claims";
	if (!R.panel) togglePanel(true);
	drawStudyPanel();
	$$(".srclink, .srchl").forEach((h) => h.classList.toggle("sel", linkOn({ kind: h.dataset.kind, ref: h.dataset.ref })));
	$("#panel .src.sel")?.scrollIntoView({ block: "nearest" });
	const L = R.links.find((x) => linkOn(x));
	if (scroll && L && R.pages[L.page]) {
		const P = R.pages[L.page], top = L.lines?.[0]?.[1] ?? L.rect[1];
		scrollTo({ top: Math.max(0, P.div.offsetTop + top * P.h - (small() ? 90 : innerHeight / 3)), behavior: "smooth" });
	}
	setTimeout(() => $$(".srclink.sel, .srchl.sel").forEach((h) => { h.classList.remove("flash"); void h.offsetWidth; h.classList.add("flash"); }), scroll ? 350 : 0);
	const hash = kind === "fact" ? `#/fact/${encodeURIComponent(ref)}` : `#/claim/${ref}`;
	if (location.hash !== hash) history.replaceState(null, "", hash);
}

const plainTitle = (t) => (t || "").replace(/---/g, "—").replace(/--/g, "–").replace(/\\[A-Za-z]+\*?/g, "").replace(/[{}$]/g, "").replace(/\s+/g, " ").trim();

// a sentence of LaTeX as plain text: facts filled in, citations as [Key]
const texText = (s) => s
	.replace(/\\fact\{([^}]*)\}/g, (_, n) => (S.study.data.facts[n] ? texText(S.study.data.facts[n].value) : `[${n}?]`))
	.replace(/\\claim\*?\{[^}]*\}/g, "")
	.replace(/\\cite[a-z]*\*?(?:\[[^\]]*\])*\{([^}]*)\}/g, (_, k) => `[${k.replace(/\s*,\s*/g, ", ")}]`)
	.replace(/\\(?:ref|eqref|autoref|cref|Cref)\{[^}]*\}/g, "#")
	.replace(/\\(?:,|;|:|!|\s)/g, " ").replace(/~/g, " ").replace(/\\times(?![A-Za-z])/g, "×").replace(/\\pm(?![A-Za-z])/g, "±").replace(/\\(?:approx|sim)(?![A-Za-z])/g, "≈")
	.replace(/\\(?:le|leq)(?![A-Za-z])/g, "≤").replace(/\\(?:ge|geq)(?![A-Za-z])/g, "≥").replace(/\\%/g, "%").replace(/---/g, "—").replace(/--/g, "–")
	.replace(/\\[A-Za-z]+\*?/g, "").replace(/[{}$]/g, "").replace(/\s+/g, " ").trim();

function claimState(ref, u) {   // the annotation a \claim names, as the store has it now, and whether it holds
	const [key, id] = ref.split("/"), out = { key, id, n: (S.notes[key] || []).find((x) => x.id === id) };
	if (!S.byKey[key]) out.problem = `${key} is not in ${S.src.repo}`;
	else if (!out.n) out.problem = "no such annotation";
	else if (out.n.status === "disputed") out.problem = "the annotation is marked disputed";
	else if (out.n.value != null && u) {
		const v = Number(typeof out.n.value === "object" ? out.n.value.number : out.n.value), unit = out.n.value.unit ? " " + out.n.value.unit : "";
		if (!Number.isNaN(v) && u.said.length) {
			if (u.said.some((x) => Math.abs(x - v) <= 1e-9 * Math.max(1, Math.abs(v)))) out.ok = `the sentence states ${v}${unit}, as the paper does`;
			else out.problem = `the paper says ${v}${unit}, the sentence says ${u.said.join(", ")}`;
		}
	}
	return out;
}

function studyChecks() {
	const d = S.study.data, problems = d.problems.map((text) => ({ text }));
	let unchecked = 0;
	d.claims.forEach((u, i) => u.refs.forEach((ref) => {
		const r = claimState(ref, u);
		if (r.problem) problems.push({ text: `${u.file}:${u.line}: \\claim{${ref}}: ${r.problem}`, ref });
		else if ((r.n.status || "unchecked") === "unchecked") unchecked++;
	}));
	return { problems, unchecked };
}

const ghUrl = (at) => `${S.study.data.repo}/blob/${at.commit || "main"}/${at.path}${at.line ? "#L" + at.line : ""}`;
const ghLine = (fileLine) => { const [path, line] = fileLine.split(":"); return el("a", { href: ghUrl({ path, line }), target: "_blank", rel: "noopener" }, fileLine); };

const peeked = {};
async function peek(at, pre, code) {   // a file as it was at the commit that made the number: the function, or the lines around a constant, or the file
	pre.dataset.loaded = "1";
	pre.textContent = "Loading…";
	const id = `${at.commit || "main"}:${at.path}`;
	try {
		peeked[id] ??= S.study.src.raw(at.path, at.commit || "main").then(async (r) => { if (!r.ok) throw new Error(`GitHub said ${r.status}`); return new Uint8Array(await r.arrayBuffer()); });
		const bytes = await peeked[id];
		if (bytes.subarray(0, 4096).includes(0)) { pre.textContent = `A binary file of ${(bytes.length / 1024).toFixed(0)} kB: open it on GitHub.`; return; }
		let text = new TextDecoder().decode(bytes.subarray(0, 400_000));
		if (!at.line && /\.json$/i.test(at.path)) try { text = JSON.stringify(JSON.parse(text), null, 1); } catch {}
		const lines = text.split("\n"), row = (i) => el("span", { class: "ln" + (i + 1 === at.line ? " mark" : "") }, el("i", {}, String(i + 1)), lines[i] || " ");
		let a = 0, b = Math.min(lines.length, 400);
		if (at.line && code) {   // the function: its decorators, its def, and every line indented under it
			a = at.line - 1; b = a;
			while (b < lines.length && /^@/.test(lines[b])) b++;
			b++;
			while (b < lines.length && b - a < 120 && (!lines[b].trim() || /^[\s)\]}]/.test(lines[b]))) b++;
			while (b > a + 1 && !lines[b - 1].trim()) b--;
		} else if (at.line) { a = Math.max(0, at.line - 4); b = Math.min(lines.length, at.line + 3); }
		pre.replaceChildren(...Array.from({ length: b - a }, (_, k) => row(a + k)),
			!at.line && lines.length > b ? el("span", { class: "ln more" }, `… ${lines.length - b} more lines: open it on GitHub`) : "");
	} catch (e) { pre.textContent = "Could not read it: " + e.message; }
}

function fileRow(at, code) {
	const pre = el("pre", { class: "peek", hidden: !code || null });
	const show = code ? null : el("button", { class: "btn mini", onclick: () => { pre.hidden = !pre.hidden; show.textContent = pre.hidden ? "show" : "hide"; if (!pre.hidden && !pre.dataset.loaded) peek(at, pre, false); } }, "show");
	if (code) peek(at, pre, true);
	return [el("div", { class: "file" }, el("a", { href: ghUrl(at), target: "_blank", rel: "noopener" }, at.path + (at.line ? `:${at.line}` : "")),
		el("span", { class: "muted" }, at.commit ? ` @ ${at.commit}` : " (uncommitted)"), show), pre];
}

function factCard(name) {
	const f = S.study.data.facts[name], on = R.sel?.kind === "fact" && R.sel.ref === name;
	const placed = R.links.some((L) => L.kind === "fact" && L.ref === name);
	return el("div", { class: "src fact" + (on ? " sel" : ""), "data-ref": name, onclick: (e) => { if (!on && !e.target.closest("a, button")) pick("fact", name, true); } },
		el("div", { class: "head" }, el("span", { class: "name" }, name), el("span", { class: "grow" }), el("code", { class: "val" }, texText(f.value))),
		el("div", { class: "where" }, f.used.length ? ["used at ", ...f.used.flatMap((u, i) => [i ? ", " : "", ghLine(u)])] : "not used", R.doc && f.used.length && !placed ? " (not linked in the draft: is it older than this sheet?)" : ""),
		on ? el("div", {}, el("div", { class: "lbl" }, "Computed by"), ...fileRow(f.code, true),
			el("div", { class: "lbl" }, f.reads.length ? `Reads ${f.reads.length === 1 ? "one file" : f.reads.length + " files"}` : "Reads no file"),
			...f.reads.flatMap((r) => fileRow(r, false))) : null);
}

function claimUseCard(u, i) {
	const on = R.sel?.kind === "claim" && R.sel.use === i, refs = u.refs.map((ref) => claimState(ref, u));
	const st = refs.some((r) => r.problem) ? "disputed" : refs.every((r) => r.n?.status === "verified") ? "verified" : "unchecked";
	return el("div", { class: `src claimuse ${st}` + (on ? " sel" : ""), onclick: (e) => { if (!on && !e.target.closest("a, button")) pick("claim", u.refs[0], true); } },
		el("div", { class: "head" }, el("span", { class: "dot " + st }), ghLine(`${u.file}:${u.line}`), u.star ? el("span", { title: "\\claim*: the sentence cites the paper itself" }, "· claim*") : null),
		el("div", { class: "sentence" }, texText(u.sentence)),
		...refs.map((r) => el("div", { class: "ref" },
			el("div", { class: "head" }, el("span", { class: "dot " + (r.problem ? "disputed" : r.n.status || "unchecked") }),
				el("b", {}, S.byKey[r.key] ? `${byline(S.byKey[r.key])} ${S.byKey[r.key].year || ""}` : r.key), r.n ? el("span", {}, `p.${r.n.page}`) : null,
				el("span", { class: "grow" }), r.n ? el("a", { href: `#/${encodeURIComponent(r.key)}/${r.id}`, title: "Open the paper at this passage" }, "open", icon("out")) : null),
			on || !r.n ? (r.n ? el("blockquote", { class: r.n.kind === "area" ? "area" : "" }, r.n.quote?.exact || r.n.label || "A box on the page") : null) : null,
			on && r.n?.note ? el("div", { class: "note" }, r.n.note) : null,
			r.problem ? el("div", { class: "problem" }, r.problem) : on && r.ok ? el("div", { class: "ok" }, r.ok) : null)));
}

function drawStudyPanel() {
	const d = S.study.data, checks = studyChecks();
	const tab = (id, label) => el("button", { class: "ptab" + (R.tab === id ? " on" : ""), onclick: () => { R.tab = id; drawStudyPanel(); } }, label);
	let body;
	if (R.tab === "facts") body = Object.keys(d.facts).length ? Object.keys(d.facts).map(factCard) : el("p", { class: "empty" }, "No facts yet: a number from the study is \\fact{name}, computed in step3_outputs/facts.py.");
	else if (R.tab === "claims") body = d.claims.length ? d.claims.map(claimUseCard) : el("p", { class: "empty" }, "No claims yet: a sentence that rests on a passage of a paper carries \\claim{Key/id}.");
	else {
		const item = (p) => el("li", { class: p.ref ? "go" : "", onclick: p.ref ? () => pick("claim", p.ref, true) : null }, p.text);
		body = el("div", { class: "checks" },
			el("h3", {}, checks.problems.length ? `${checks.problems.length} problem${checks.problems.length === 1 ? "" : "s"}` : "No problems"),
			checks.problems.length ? el("ul", { class: "bad" }, ...checks.problems.map(item))
				: el("p", { class: "muted" }, "Every fact is defined and used, and every claim names an annotation that is not disputed and agrees with its sentence."),
			checks.unchecked ? el("p", { class: "muted" }, `${checks.unchecked} claimed passage${checks.unchecked === 1 ? " is" : "s are"} not yet marked verified: open each, read it, and mark it.`) : null,
			el("h3", {}, `${d.unsourced.length} sentence${d.unsourced.length === 1 ? "" : "s"} with a number and no source`),
			el("p", { class: "muted" }, "No \\fact, \\claim or \\cite in them. Some numbers are names (a design, an equation); the rest are typed and could go stale."),
			el("ul", { class: "loose" }, ...d.unsourced.map((x) => el("li", {}, ghLine(`${x.file}:${x.line}`), " ", texText(x.sentence)))));
	}
	const grip = el("div", { class: "grip", onclick: () => $("#panel").classList.toggle("tall") });
	$("#panel").replaceChildren(grip, el("div", { class: "ptabs" }, tab("facts", `Facts · ${Object.keys(d.facts).length}`), tab("claims", `Claims · ${d.claims.length}`),
		tab("checks", checks.problems.length ? `Checks · ${checks.problems.length} ✗` : "Checks ✓"), el("span", { class: "grow" }),
		small() ? btn("close", "Close", () => togglePanel(false)) : null), el("div", { class: "pbody" }, body));
}

// ---- wiring -------------------------------------------------------------------------------

async function route() {
	$("#pop").hidden = true;
	if (S.boxing) setBoxing(false);
	if (R?.study) R.y = scrollY;
	const [, a, b, c] = location.hash.replace(/^#/, "").split("/");
	try {
		if (S.study && (!a || a === "fact" || a === "claim")) return await studyView(a ? a : null, a === "fact" ? decodeURIComponent(b) : a === "claim" ? `${decodeURIComponent(b)}/${c}` : null);
		if (!a || a === "library") { R = null; return libraryView(); }
		if (a === "claims") { R = null; return await claimsView(); }
		return await readerView(decodeURIComponent(a), b);
	} catch (e) { $("#main").replaceChildren(el("div", { class: "wrap" }, el("p", {}, "Could not open this: " + e.message), el("a", { href: "#/" }, "Back to the library"))); }
}

async function start() {
	auth.takeFromFragment();
	if (params.get("repo")) store.set("ps.repo", params.get("repo"));
	if (params.has("demo")) S.src = new StaticSource(CFG.demo || "demo/");
	else {
		if (!auth.token) return signinView();
		S.src = new GitHubSource(store.get("ps.repo") || CFG.repo, CFG.branch);
		const study = params.get("study");
		if (study) S.study = { repo: study, src: new GitHubSource(study, "main"), drafts: new GitHubSource(study, "drafts") };
	}
	try { S.me = await S.src.user(); await loadStore(); }
	catch (e) { if (/sign/.test(e.message)) auth.clear(); return signinView(e.message); }
	await route();
}

addEventListener("hashchange", route);
document.addEventListener("selectionchange", () => { clearTimeout(placePop.t); placePop.t = setTimeout(placePop, 180); });
addEventListener("keydown", (e) => {
	if (e.target.closest?.("input, textarea, select, dialog") || !R) return;
	if ((e.key === "b" || e.key === "B") && S.src.canEdit && !R.study) setBoxing(!S.boxing);
	if (e.key === "Escape") { setBoxing(false); $("#pop").hidden = true; }
	if ((e.ctrlKey || e.metaKey) && e.key === "f" && R.find) { e.preventDefault(); R.find.input.closest(".findbox").hidden = false; R.find.input.focus(); }
});
let lastW = innerWidth;
addEventListener("resize", () => { clearTimeout(relayout.t); relayout.t = setTimeout(() => { if (R?.doc && Math.abs(innerWidth - lastW) > 40) { lastW = innerWidth; relayout(); } }, 250); });
start();
