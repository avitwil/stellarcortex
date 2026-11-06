#!/usr/bin/env bash
# What https://stellarcortex.avitwil.io/install.sh serves. scripts/release.mjs fills in the keys.
# The signature cannot cover this script: it covers what the script installs.
# All of it is in one function, so a download cut off halfway runs nothing.
set -euo pipefail
tmp=
staged=
main(){
 local keys='@@PINNED_KEYS@@'
 local minimum='@@MINIMUM_VERSION@@'
 local latest=https://api.github.com/repos/avitwil/stellarcortex/releases/latest
 local base=https://github.com/avitwil/stellarcortex/releases/download
 local dir=${STELLARCORTEX_INSTALL_DIR:-$HOME/stellarcortex}
 die(){ echo "StellarCortex: $1" >&2; exit 1; }
 [[ "$(uname -s)" == Linux ]] || die "version 0.1 supports Linux only, and this system is $(uname -s). A Windows version is planned."
 [[ "$(id -u)" != 0 ]] || die 'run this as your regular user, not as root. It asks for sudo when it needs it.'
 [[ "$keys$minimum" != *@@* ]] || die 'this script has no release key. Get it from https://stellarcortex.avitwil.io.'
 command -v curl >/dev/null && command -v tar >/dev/null || die 'curl and tar are required. Install them, then run this again.'
 [[ ! -e "$dir/package.json" ]] || die "$dir already holds an install. Update it from Settings, or set STELLARCORTEX_INSTALL_DIR."
 node_ready(){ command -v node >/dev/null && command -v npm >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<16))process.exit(1)'; }
 # Apt's output only matters when it fails.
 quiet(){ local log code=0; log=$(mktemp); "$@" </dev/null >"$log" 2>&1 || code=$?; [ "$code" = 0 ] || cat "$log" >&2; rm -f "$log"; return "$code"; }
 if ! node_ready && command -v apt-get >/dev/null; then
  echo 'Installing Node.js and npm. This needs root.'
  { quiet sudo apt-get update && quiet sudo apt-get install -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold nodejs npm; } </dev/null || true
 fi
 node_ready || die 'Node.js 22.16+ and npm are required. Install them for the whole system from https://nodejs.org, then run this again.'
 tmp=$(mktemp -d)
 trap 'rm -rf "$tmp" "$staged"' EXIT
 local get=(curl -fsSL --proto '=https' --tlsv1.2)
 "${get[@]}" -o "$tmp/latest" "$latest" || die 'could not find the latest release. If you ran this many times, wait a few minutes.'
 local tag
 tag=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).tag_name' "$tmp/latest" 2>/dev/null) || die 'could not read the latest release.'
 [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || die 'the latest release has no valid version.'
 base=$base/$tag
 "${get[@]}" -o "$tmp/release.json" "$base/release.json" || die 'could not download the release details.'
 "${get[@]}" -o "$tmp/release.json.sig" "$base/release.json.sig" || die 'could not download the release details.'
 # The same checks as src/signed-releases.mjs, with no installed copy of the app to run them yet.
 local check='
const fs=require("fs"),crypto=require("crypto"),[keys,manifest,sig,tag,minimum]=process.argv.slice(1);
const fail=text=>{console.error("StellarCortex: "+text);process.exit(1);};
const bytes=fs.readFileSync(manifest);let detached;try{detached=JSON.parse(fs.readFileSync(sig,"utf8"));}catch{fail("the release signature is not readable.");}
const key=JSON.parse(keys).find(item=>item.id===detached.keyId);if(!key)fail("the release is signed by a key this script does not trust.");
const publicKey=crypto.createPublicKey({key:Buffer.from(key.publicKey,"base64"),format:"der",type:"spki"});
const signed=Buffer.concat([Buffer.from("stellarcortex-release-v1\n"),bytes]);
if(typeof detached.signature!=="string"||!crypto.verify(null,signed,publicKey,Buffer.from(detached.signature,"base64")))fail("the release signature is not valid.");
const entry=JSON.parse(bytes.toString("utf8"));if(entry.schema!==1)fail("this release needs a newer install script.");
if(entry.version!==tag.slice(1)||entry.file!==`stellarcortex-${entry.version}.tar.gz`||!/^[a-f0-9]{64}$/.test(entry.sha256))fail("the release manifest is not valid.");
const parts=value=>value.split("-")[0].split(".").map(Number),now=parts(entry.version),floor=parts(minimum),at=[0,1,2].find(i=>now[i]!==floor[i]);
if(at!==undefined&&now[at]<floor[at])fail("the latest release is older than this script allows, so it was refused. Get a new install script.");
console.log([entry.version,entry.file,entry.sha256].join(" "));'
 local version file sha
 read -r version file sha < <(node -e "$check" "$keys" "$tmp/release.json" "$tmp/release.json.sig" "$tag" "$minimum") || true
 [[ -n "${sha:-}" ]] || exit 1
 echo "Downloading StellarCortex $version."
 "${get[@]}" -o "$tmp/$file" "$base/$file" || die 'could not download the release.'
 node -e 'const [file,sha]=process.argv.slice(1);if(require("crypto").createHash("sha256").update(require("fs").readFileSync(file)).digest("hex")!==sha)process.exit(1)' "$tmp/$file" "$sha" || die 'the release file does not match its signed hash, so it was refused.'
 echo "Signature verified: this is the signed StellarCortex $version."
 staged=$dir.new.$$
 mkdir -p "$staged"
 tar -xzf "$tmp/$file" -C "$staged" --strip-components=1 --no-same-owner
 node -e 'const [file,version]=process.argv.slice(1),pkg=JSON.parse(require("fs").readFileSync(file,"utf8"));if(pkg.name!=="stellarcortex"||pkg.version!==version)process.exit(1)' "$staged/package.json" "$version" || die 'the release does not hold the version it was signed for.'
 rmdir "$dir" 2>/dev/null || true
 [[ ! -e "$dir" ]] || die "$dir already exists and is not empty. Set STELLARCORTEX_INSTALL_DIR to another folder."
 mv "$staged" "$dir"
 staged=
 cd "$dir"
 bash install.sh --service </dev/null
}
main "$@"
