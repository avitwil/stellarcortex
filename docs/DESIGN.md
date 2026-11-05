# StellarCortex visual system

The StellarCortex logo is the visual reference: `public/stellar-cortex-logo.svg`. The interface is a Hebrew/English workspace for bots, conversations, tools and computers.

## Design references

- [UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill), revision `28b3b8dee8c976df4fa3e94aed4e092ad43fcb03`: accessible color pairs, visible focus, responsive layout and reduced motion. Its minimalism style and chat-product palette guidance were used; its marketing-page patterns do not apply to a workspace and were not used.
- [Anthropic Frontend Design](https://github.com/anthropics/claude-code/blob/main/plugins/frontend-design/skills/frontend-design/SKILL.md): subject-specific identity, a deliberate type scale and restrained effects.

The app uses native HTML, CSS and JavaScript; no React or Tailwind.

## Direction

The logo is the expressive element. The surrounding interface uses quiet navy work surfaces and restrained violet/cyan interaction colors. Readable conversations take priority over decorative panels. Light and dark modes share semantic roles.

Core dark palette: night `#0A0F1C`, panel `#121B2F`, ink `#F0F3FF`, lavender `#BDA5FF`, cyan `#67DCEC`, magenta `#E694E8`. The light counterpart uses white/lavender surfaces, dark ink and stronger accents for contrast. Status always carries a visible label, not color alone.

Fonts are self-hosted in `public/fonts/` under the SIL Open Font License, with each licence in `public/fonts/licenses/`, so the interface never contacts a third-party CDN. System fonts remain the fallback. Message text, controls and metadata follow a fixed size hierarchy. Long content wraps; code and server URLs keep their left-to-right direction.

The layout has a sidebar, the conversation and composer, and an optional detail pane. Hebrew mirrors the reading direction. Rows stay compact, and cards group real service or configuration boundaries. There are no placeholder metrics, promotional sections or decorative animations.

## Designs

Settings > General offers three designs. Each works in both color modes and in Hebrew and English, and the choice is saved with the other settings.

| Design | Character | Layout |
|---|---|---|
| Observatory (default) | Calm night surfaces, Assistant and Bellefair type | Sidebar with the team as a tree, settings in a dialog |
| Daylight | Bright and friendly, Rubik type | Navigation rail and conversation list, settings as a page |
| Mission control | Dense and fast, IBM Plex type | Command bar, team panel, live activity pane, settings as a page |

A design is a `DESIGNS` entry in `public/themes/design.js` plus a stylesheet in `public/themes/`. All its rules are scoped to `html[data-design=<id>]`, with tokens on `body` and `body.light`. Layout flags in the entry (`teamTree`, `rail`, `pageSettings`, `mission`) switch on the behaviour in `createDesignHost`; `app.js` only calls its `sidebar()` and `render()` hooks. Designs change presentation only and reuse the existing actions and data.

`test/design-harness/server.mjs` serves the interface with fixture data on port 8780, without a data directory or a real server.

## Checks

UI changes are checked in every design, in both color modes and both languages, with keyboard focus, at narrow and wide widths, with the logo's proportions intact and no horizontal page overflow.
