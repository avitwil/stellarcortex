# Third-party notices

StellarCortex's own code is under the [MIT license](LICENSE). That license does not cover the software below, which keeps its own license and terms.

**What is in this repository and what is not.** Only the files in [Included in this repository](#included-in-this-repository) ship here. Everything else is downloaded at install time, from its own source, onto your machine. This repository does not redistribute it, and you receive it under its own terms.

<a id="provider-terms"></a>
## Provider terms

StellarCortex can connect to accounts and services run by other companies. Before you connect any provider account, subscription or API key, check that provider's current terms of use yourself. You are responsible for complying with them.

Terms can change at any time, and a connection that works today may stop working. StellarCortex does not say that any use of a provider's account or subscription is allowed, and it does not promise that any connection will keep working.

StellarCortex is an independent project. It is not affiliated with or endorsed by any provider, and all product names belong to their owners. The software is provided "as is", without warranty of any kind, as stated in the MIT license.

## Included in this repository

| Component | Version | License | Where | Notices |
| --- | --- | --- | --- | --- |
| [noVNC](https://github.com/novnc/noVNC) core | 1.6.0 | MPL-2.0 | `public/vendor/novnc/core` | `public/vendor/novnc/LICENSE.MPL-2.0.txt`, `public/vendor/novnc/COPYRIGHT.txt`, `public/vendor/novnc/SOURCE.json` |
| pako, inside noVNC | see noVNC | MIT and Zlib | `public/vendor/novnc/vendor/pako` | `public/vendor/novnc/COPYRIGHT.txt` |
| DES code, inside noVNC | see noVNC | BSD-2-Clause and the notices in that file | `public/vendor/novnc/core/crypto/des.js` | `public/vendor/novnc/COPYRIGHT.txt` |
| Assistant font | | SIL OFL 1.1 | `public/fonts` | `public/fonts/licenses/assistant-OFL.txt` |
| Bellefair font | | SIL OFL 1.1 | `public/fonts` | `public/fonts/licenses/bellefair-OFL.txt` |
| IBM Plex Mono font | | SIL OFL 1.1 | `public/fonts` | `public/fonts/licenses/ibm-plex-mono-OFL.txt` |
| IBM Plex Sans Hebrew font | | SIL OFL 1.1 | `public/fonts` | `public/fonts/licenses/ibm-plex-sans-hebrew-OFL.txt` |
| Rubik font | | SIL OFL 1.1 | `public/fonts` | `public/fonts/licenses/rubik-OFL.txt` |

The source of noVNC is at the link above, and `SOURCE.json` records the hash of each file here. The Kanban page's interaction design takes NousResearch/hermes-agent (MIT) as a reference, as noted in `public/kanban.js`.

## Downloaded by npm at install

`npm ci` installs these into `node_modules`, which is not part of this repository. The exact versions are in `package-lock.json`.

| Package | Version | License |
| --- | --- | --- |
| `@anthropic-ai/claude-code` and its 8 platform packages (optional) | 2.1.310 | **Proprietary.** © Anthropic PBC. Not open source. See [its legal page](https://code.claude.com/docs/en/legal-and-compliance) |
| `@openai/codex` and its 6 platform packages | 0.164.0 | Apache-2.0 |
| `@modelcontextprotocol/client`, `@modelcontextprotocol/core` | 2.4.0 | Apache-2.0 |
| `playwright`, `playwright-core` | 1.64.1 | Apache-2.0 |
| `cross-spawn` | 7.0.6 | MIT |
| `eventsource` | 3.0.7 | MIT |
| `eventsource-parser` | 3.1.1 | MIT |
| `jose` | 6.2.13 | MIT |
| `path-key` | 3.1.1 | MIT |
| `pkce-challenge` | 5.0.1 | MIT |
| `shebang-command` | 2.0.0 | MIT |
| `shebang-regex` | 3.0.0 | MIT |
| `ws` | 8.22.1 | MIT |
| `zod` | 4.6.7 | MIT |
| `isexe` | 2.0.0 | ISC |
| `which` | 2.0.2 | ISC |

Do not vendor Claude Code into this repository, a release archive or a published container image. An image built from `Dockerfile` contains it, so keep such an image for your own use.

## Downloaded by the setup scripts

| Software | From | License |
| --- | --- | --- |
| Chromium for the host browser | Playwright's download service, through `playwright install chromium` | Set by its publisher. Not reviewed here |
| Chrome for Testing, pinned in `deployment/ubuntu-desktop/guest/chromium-pin.json` | `cdn.playwright.dev`, fetched inside the virtual computer | Not confirmed. The download holds a Widevine `LICENSE` file and an `ABOUT` file, and no license for the browser itself. Check the publisher's terms before you redistribute it |
| Ubuntu Server | Ubuntu's release servers | Many licenses, see [Ubuntu's legal pages](https://ubuntu.com/legal) |
| QEMU, libvirt, OVMF, swtpm, dnsmasq, xorriso, GnuPG, nftables and related host packages | Your distribution's `apt` repositories | Each package's license is in `/usr/share/doc/<package>/copyright` on your machine |
| TigerVNC, Xfce, Node.js, fonts and the other packages in the virtual computer | Ubuntu's `apt` repositories | Each package's license is in `/usr/share/doc/<package>/copyright` inside the virtual computer |

The setup scripts do not install model servers or download model weights.
