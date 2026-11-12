# Sign in with GitHub

GitHub turns a login into a token only for someone holding the app's client
secret, which cannot live in a public page. `worker.js` holds it, on Cloudflare
Workers' free plan, and stores nothing.

1. **GitHub App.** GitHub → Settings → Developer settings → GitHub Apps → New.
   - Homepage URL: the viewer's URL.
   - Callback URL: `https://paperstore-auth.<your-subdomain>.workers.dev/callback`
     (Cloudflare shows the subdomain after the first deploy; edit this then).
   - Untick Webhook → Active.
   - Repository permissions → Contents: **Read and write**. Nothing else.
   - Create it, note the **Client ID**, and generate a **client secret**.
   - Install App → your account → **Only select repositories** → the store.
2. **Worker.** In this folder, with Node installed:

        npx wrangler login
        npx wrangler secret put CLIENT_SECRET     # paste the secret
        # set CLIENT_ID and VIEWER in wrangler.toml, then
        npx wrangler deploy

3. **Viewer.** Put the worker's URL in `docs/config.js` as `auth`.

To share the store, add people as collaborators on the repository; they sign in
with their own accounts. The app only reaches repositories it is installed on,
and only those the signed-in person could already read.
