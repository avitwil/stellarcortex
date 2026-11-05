# Releasing

Releases are signed on the maintainer's computer. The private keys never go into this repository or onto a server.

## One-time setup: keys

Create two keys, each with its own passphrase. Keep them outside this repository.

```bash
node scripts/release.mjs keygen --out /path/outside/the/repo/stellarcortex-primary.pem
node scripts/release.mjs keygen --out /path/on/offline/media/stellarcortex-recovery.pem
```

Each command prints an entry. Add both entries to the `keys` list in `update-keys.json`, commit it, and back up both key files. Keep the recovery key in a different place, and use it only if the primary key is lost or stolen.

An empty `update-keys.json` means no install or update will succeed.

## Publish a version

1. Set the version in `package.json` and `package-lock.json`, commit, and tag it: `git tag v0.2.0`.
2. Build and sign from a clean tree. This publishes nothing:

   ```bash
   node scripts/release.mjs build --tag v0.2.0 --key /path/to/stellarcortex-primary.pem --out /path/to/empty/folder --notes-en "What changed" --notes-he "מה השתנה"
   ```

3. Push the tag, then create the GitHub release with the command the tool prints. It attaches the tarball, `release.json` and `release.json.sig`. Do not mark it as a prerelease, or installed copies will not see it.
4. Copy `install.sh` to the website, and put its printed SHA-256 in the release notes. It refuses any release older than the one it was built for. If you delete that release from GitHub, put the previous `install.sh` back.

The tool refuses a dirty tree, a tag that does not match `package.json`, a tag that is not the newest, a key that is not pinned, and a key that the previous tag does not pin.

The tool sets `kitVersion` to the last tag that changed what the root step packs or pins, so installed copies also run it. That covers `src`, `scripts`, `deployment`, the lockfile and the keys, so most releases do. Keep the broker compatible with the previous release, because an app rollback leaves the root parts on the new version.

## Replace a key

1. Generate the new key, and add it to `update-keys.json` next to the old one.
2. Publish a release signed with the old key.
3. Remove the old key from `update-keys.json`, and publish the next release signed with the new key.

The tool refuses a key that the previous tag does not pin. A copy that skipped step 2 cannot verify the new key and must reinstall, so leave time between the two releases.

## If a key is stolen

Publish a release signed with the recovery key, with the stolen key removed from `update-keys.json`. Tell users. An install that applied a release signed by the attacker must be reinstalled.

## If the website or the GitHub account is compromised

Installed copies refuse anything unsigned. New installs are at risk from the website, because `install.sh` itself is not signed. Rebuild the website, and tell anyone who ran the install during that time to reinstall. An attacker with the GitHub account but not the key can only hide new releases.

Details of the format are in [UPDATES.md](UPDATES.md).
