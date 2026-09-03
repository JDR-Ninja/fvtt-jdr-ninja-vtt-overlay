# JDR Ninja VTT Overlay

A [Foundry VTT](https://foundryvtt.com/) module that streams your table's **actual
Foundry dice rolls** onto a transparent OBS overlay hosted by [JDR Ninja](https://www.jdr.ninja).
Foundry is the dice authority: the module sends the exact result your players saw
(formula, per-die faces and total), and JDR Ninja **replays** it on the overlay. It
**never re-rolls**, so the number on stream always matches the number at the table.

- **System-agnostic.** It hooks core chat rolls (`createChatMessage` to `message.rolls`),
  so any roll that reaches chat is captured regardless of game system.
- **Works with or without [Dice So Nice](https://gitlab.com/riccisi/foundryvtt-dice-so-nice).**
  When DSN is present, the overlay dispatch is synchronized with DSN's animation and can
  approximate the roller's dice colors, material and font (cosmetic only). When DSN is
  absent, the roll is sent immediately.
- **Hidden rolls stay hidden.** GM (`gmroll`), blind (`blindroll`) and self/whispered
  (`selfroll`) rolls are never sent to the public overlay.

## Free vs paid

The module is **free to install and pair**. Linking a browser to a JDR Ninja account,
running the diagnostics, and sending the built-in test roll all work at no cost.

**Relaying real Foundry rolls to the OBS overlay requires a paid JDR Ninja plan.**
Without a paid plan, pairing and diagnostics still work, but live roll posts are declined
(the module shows a "subscription required" message) and no dice animate on the overlay.
A client-only visual demo remains available on the JDR Ninja VTT Overlay settings page on
the website.

## Install

In Foundry: **Add-on Modules, Install Module**, then paste the manifest URL:

```
https://github.com/JDR-Ninja/fvtt-jdr-ninja-vtt-overlay/releases/latest/download/module.json
```

Enable the module in your world (**Game Settings, Manage Modules**).

Requires Foundry VTT **v13+** (verified on **v14**). [Dice So Nice] is an optional,
suggested companion.

## Pairing (recommended: in-module device flow)

No copy-paste needed. Each streamer pairs their **own browser** to their **own** JDR Ninja
account:

1. Open **Game Settings, Configure Settings, JDR Ninja VTT Overlay** (the settings menu).
2. Click **Link**. A JDR Ninja page opens in a new tab with a short code.
3. On that page (while logged in to JDR Ninja), approve the named device.
4. The module stores the token automatically and **auto-enables** the
   *Relay rolls from this device* toggle. Roll a die to test.

Anyone at the table can pair: the menu is **not** GM-restricted. Two players streaming
means two independent relays to two different overlays, which is correct, not a collision.

### Manual pairing (fallback)

For locked-down environments, expand **Advanced configuration** in the settings panel and
paste a token you generated on the JDR Ninja VTT Overlay page, along with the base URL.

## The device token is client-scoped (re-pair per browser)

Every setting in this module, including the device token, is stored in Foundry's
**`client` scope**: per-browser, not written to the world database, not exported with the
world, and not visible to other GMs. This is deliberately safer for a per-streamer secret.

**Consequence:** the token lives only in the browser where you paired. If you stream from a
different machine or browser profile, you must **pair again there.** The token is never
rendered back into the settings panel after it is stored.

## How relay election works

The relay is elected purely client-side by *"does this browser hold the streaming token"*
plus the local **Relay rolls from this device** toggle. There is no Foundry role check and
no world setting. Whoever pairs their browser broadcasts every public roll they can see to
*their own* overlay. Accidental duplicates (for example the same account in two tabs) are
absorbed by the server's per-overlay idempotency on the Foundry message id.

## Diagnostics and test

The settings panel exposes:

- **Test connection** runs `GET /api/vtt-overlay/foundry/diagnostics` and renders an
  actionable checklist (Configuration, Relay, Authentication, Subscription, Overlay active,
  OBS connected, Network). "OBS not connected" is a warning, not a failure.
- **Send a test roll** POSTs an unmistakable pre-rolled `1d20 = 20` to the same endpoint
  real rolls use, so you can watch the whole chain animate in OBS before going live.

The last successful test and last error timestamp are shown in the panel so a mid-stream
failure is diagnosable afterward.

## Localization

The module ships **English, French, Spanish, German and Portuguese (Brazil)**. English is
the base/fallback. This is a deliberate exception to JDR Ninja's French-only website policy:
the Foundry module is distributed internationally through Foundry's package registry, so its
in-module UI is multilingual. The manifest text (`module.json` title/description) stays in
English, which is Foundry's canonical manifest language.

## Privacy and security notes

- Only **public** rolls are ever sent. The hidden-roll filter (`whisper`/`blind`) is always
  on and is not a user option.
- Dice So Nice appearance pass-through is a **cosmetic, copyright-safe subset** (hex colors
  plus material/font *names* used as hints). The module never copies DSN textures, meshes or
  colorset tables.
- The device token grants only the ability to animate **your own** overlay. Revoke it on the
  JDR Ninja VTT Overlay page if a machine is lost.

## Development

```bash
npm install
npm run build     # bundles scripts/, stages dist/, produces module.zip
npm run watch     # rebuild the bundle on change, no zip
```

### Cutting a release

A `v*` tag is the whole release. Create it on GitHub (**Releases**, *Draft a new release*,
*Create new tag on publish*, e.g. `v1.0.1`) and `.github/workflows/release.yml` takes over:
it stamps the tag's version into `module.json`, re-points `download` at that tag, runs the
consistency check, builds, and attaches `module.json` and `module.zip` to the release. The
assets land a minute or so after the release appears.

The tag is the source of truth for the version, so no commit is needed beforehand. Tag names
must be `v<major>.<minor>.<patch>`; anything else either fails loudly or, without the leading
`v`, never starts the workflow at all. To rebuild a tag that already exists, run the workflow
manually from the **Actions** tab and give it the tag name, rather than deleting and
recreating the tag.

Optionally, to record the shipped version in the repo and build the exact zip locally first:

```bash
npm run release -- patch
```

That bumps `module.json`, re-points `manifest`/`download` and rebuilds. Committing, tagging
and pushing stay in your hands; pushing a `v*` tag runs the same workflow.

## License

[MIT](LICENSE).

"JDR Ninja" and the JDR Ninja logo are trademarks of JDR Ninja. The MIT license covers the
source code only: it does not grant permission to use the JDR Ninja name or branding to
identify a fork or a derived work.

[Dice So Nice]: https://gitlab.com/riccisi/foundryvtt-dice-so-nice
