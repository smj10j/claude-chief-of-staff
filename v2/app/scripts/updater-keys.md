# Updater key generation

PRD-103 Phase 1B uses Tauri's signed updater. Updates that fail signature verification are silently rejected — the user never gets a malicious bundle, even if someone takes over the GitHub release.

This is a one-time setup. Run it before publishing your first release.

## Generate the keypair

```bash
cd v2/app
npx @tauri-apps/cli signer generate -w ~/.tauri/cos-app.key
```

This produces:

- `~/.tauri/cos-app.key` — **private key**. Never commit this. Stash it in 1Password / your password manager. CI uses it to sign release manifests.
- `~/.tauri/cos-app.key.pub` — **public key**. Goes into `tauri.conf.json` under `plugins.updater.pubkey`.

When prompted for a password, pick one and stash it alongside the private key. CI reads it from a secret.

## Wire the public key

Open `v2/app/src-tauri/tauri.conf.json` and replace the placeholder:

```json
"plugins": {
  "updater": {
    "active": true,
    "endpoints": [
      "https://github.com/<your-user>/<repo>/releases/latest/download/latest.json"
    ],
    "pubkey": "<paste contents of ~/.tauri/cos-app.key.pub here>"
  }
}
```

Set `active: true` to enable the updater on next launch. The placeholder `REPLACE_AT_RELEASE_TIME` keeps it disabled in dev so Tauri doesn't try to hit the (nonexistent) endpoint.

## Sign a release

The Tauri CLI handles signing automatically when `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` env vars are set:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/cos-app.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<your password>"
npm run tauri build
```

The build produces:

- `Chief of Staff_<version>_aarch64.dmg` (the installable bundle)
- `Chief of Staff_<version>_aarch64.app.tar.gz` (the update payload)
- `Chief of Staff_<version>_aarch64.app.tar.gz.sig` (the signature)

## The release manifest

Tauri expects a JSON manifest at the configured endpoint. The shape is:

```json
{
  "version": "0.1.1",
  "notes": "Bug fixes and improvements.",
  "pub_date": "2026-05-12T10:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<contents of the .sig file>",
      "url": "https://github.com/.../releases/download/v0.1.1/Chief%20of%20Staff_0.1.1_aarch64.app.tar.gz"
    }
  }
}
```

Mark a fix as urgent (60-second restart prompt instead of soft toast) by prefixing notes with `URGENT:`:

```json
{ "version": "0.1.2", "notes": "URGENT: fixes a crash when opening...", ... }
```

## GitHub Releases workflow

The endpoint format `releases/latest/download/latest.json` always points at the most recent release's manifest. To publish:

1. Tag the commit: `git tag v0.1.1 && git push origin v0.1.1`
2. Build with the env vars set: produces `.dmg`, `.app.tar.gz`, `.sig`
3. Create a GitHub release at the tag, attach all three files
4. Generate `latest.json` (small script in `bin/release.sh` planned in Phase 2.3) and attach it too

Once the release is live, every running app will pick up the update on its next 5-second-after-startup auto-check.

## Testing the flow safely

The `npm run tauri:fresh` recipe (see `cos-dev/implementations/installation-rollout.md` §0.5) lets you simulate a fresh install. To test the updater:

1. Build v0.1.0 locally; install it to `/Applications/Chief of Staff.app`
2. Bump to v0.1.1 in `tauri.conf.json` + `Cargo.toml` + `package.json`
3. Build v0.1.1; upload to a test GitHub release
4. Launch the v0.1.0 install; the updater should detect v0.1.1 within seconds
5. Watch the banner appear, click "download," watch the progress, click "restart now"
6. Confirm the relaunched app is on v0.1.1 (Settings → Updates shows the version)

Each of those steps maps to a state in the `UpdateState` machine; if any transition stalls, the wizard's status string in Settings → Updates surfaces the cause.
