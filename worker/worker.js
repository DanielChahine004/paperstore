// "Sign in with GitHub" for the viewer: a Cloudflare Worker that completes GitHub's login.
// GitHub needs the app's client secret to turn a login code into a token, and a secret
// cannot live in a public page, so this holds it. It stores nothing: the token goes
// straight back to the viewer, in the URL fragment, which never reaches a server.
//
// Settings (wrangler.toml [vars] and `wrangler secret put`):
//   CLIENT_ID      the GitHub App's client ID
//   CLIENT_SECRET  its client secret (a secret)
//   VIEWER         the viewer's URL; tokens are only ever sent there
//   VIEWERS        optional: more viewer URLs, space or comma separated (labs' own
//                  copies), each approved by whoever runs this worker
//
//   GET  /login?then=/Key&back=<viewer url>   -> GitHub's sign-in page
//   GET  /callback?code=...&state=...          -> back to the viewer with #token=...
//   POST /refresh {refresh_token}              -> a new token, before the old one expires
//   POST /device                               -> a code to type at github.com/login/device
//   POST /device/poll {device_code}            -> the token once the code is approved,
//                                                 else {error: "authorization_pending" | ...}
// The /device pair is GitHub's device flow (sign in on another device, e.g. a phone);
// it needs "Enable Device Flow" ticked in the GitHub App's settings, and no secret.

export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		// every viewer allowed to receive a token; the first is the default
		const viewers = [env.VIEWER, ...(env.VIEWERS || "").split(/[\s,]+/)].filter(Boolean).map((v) => v.replace(/\/?$/, "/"));
		const viewer = viewers[0];
		const allowed = (u) => typeof u === "string" && viewers.some((v) => u.startsWith(v));
		const origin = req.headers.get("Origin");
		const cors = { "Access-Control-Allow-Origin": viewers.some((v) => new URL(v).origin === origin) ? origin : new URL(viewer).origin,
			"Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS", Vary: "Origin" };

		if (url.pathname === "/login") {
			// the viewer passes ?back= (its own address, with any ?repo=); only an approved viewer gets the token
			const back = url.searchParams.get("back") || viewer;
			const state = JSON.stringify({ then: url.searchParams.get("then") || "/", back: allowed(back) ? back : viewer });
			const gh = new URL("https://github.com/login/oauth/authorize");
			gh.searchParams.set("client_id", env.CLIENT_ID);
			gh.searchParams.set("redirect_uri", url.origin + "/callback");
			gh.searchParams.set("state", btoa(state));
			return Response.redirect(gh.toString(), 302);
		}

		if (url.pathname === "/callback") {
			let state;
			try { state = JSON.parse(atob(url.searchParams.get("state") || "")); } catch { return new Response("bad state", { status: 400 }); }
			const back = allowed(state.back) ? state.back : viewer;
			const tok = await exchange(env, { code: url.searchParams.get("code") });
			if (!tok.access_token) return new Response("GitHub refused the sign-in: " + (tok.error_description || tok.error || "unknown"), { status: 400 });
			const frag = new URLSearchParams({ token: tok.access_token, refresh: tok.refresh_token || "", expires_in: String(tok.expires_in || 0), then: state.then || "/" });
			return Response.redirect(back.split("#")[0] + "#" + frag.toString(), 302);
		}

		if (url.pathname === "/refresh") {
			if (req.method === "OPTIONS") return new Response(null, { headers: cors });
			if (req.method !== "POST") return new Response("POST only", { status: 405, headers: cors });
			const { refresh_token } = await req.json().catch(() => ({}));
			if (!refresh_token) return new Response("no refresh_token", { status: 400, headers: cors });
			const tok = await exchange(env, { grant_type: "refresh_token", refresh_token });
			if (!tok.access_token) return new Response(JSON.stringify(tok), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
			return new Response(JSON.stringify({ access_token: tok.access_token, refresh_token: tok.refresh_token, expires_in: tok.expires_in }),
				{ headers: { ...cors, "Content-Type": "application/json" } });
		}

		if (url.pathname === "/device" || url.pathname === "/device/poll") {
			if (req.method === "OPTIONS") return new Response(null, { headers: cors });
			if (req.method !== "POST") return new Response("POST only", { status: 405, headers: cors });
			const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });
			if (url.pathname === "/device") {
				const r = await gh("https://github.com/login/device/code", { client_id: env.CLIENT_ID });
				if (!r.device_code) return json(r, 502);
				return json({ device_code: r.device_code, user_code: r.user_code, verification_uri: r.verification_uri, interval: r.interval, expires_in: r.expires_in });
			}
			const { device_code } = await req.json().catch(() => ({}));
			if (!device_code) return json({ error: "no device_code" }, 400);
			const tok = await gh("https://github.com/login/oauth/access_token",
				{ client_id: env.CLIENT_ID, device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
			if (!tok.access_token) return json({ error: tok.error || "unknown", interval: tok.interval });
			return json({ access_token: tok.access_token, refresh_token: tok.refresh_token, expires_in: tok.expires_in });
		}

		return new Response("paperstore sign-in helper", { status: 404 });
	},
};

async function gh(url, body) {
	const r = await fetch(url, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body) });
	return r.json().catch(() => ({ error: `GitHub said ${r.status}` }));
}

function exchange(env, params) {
	return gh("https://github.com/login/oauth/access_token", { client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET, ...params });
}
