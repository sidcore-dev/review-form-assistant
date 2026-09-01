# Review Form Assistant

A Manifest V3 browser extension plus a local Node.js server that suggests answers
for visible multiple-choice and checkbox questions on Google Forms pages.

Intended for **authorized, ungraded review material**: practice sets you own or
are permitted to use, and forms you are testing yourself. The extension cannot
submit a form and cannot move between form pages. Every suggestion is a
suggestion, and language models get things wrong.

## Quick start

macOS: double-click **Install-macOS.command**.
Windows: double-click **Install-Windows.bat**.

The installer checks your Node version, runs the test suite and the permission
audit, starts the local server, opens a setup page where you paste your API key
into a form, and opens the extension folder for you.

It stops there. It does not install the extension into Brave and changes no
browser setting. Chromium does not permit a script to load an unpacked
extension, and that restriction is the reason this project is safe to hand to
someone else. The last three steps are printed on screen and take about fifteen
seconds:

1. Open `brave://extensions` (the installer put it on your clipboard)
2. Turn on Developer mode
3. Click Load unpacked and choose the `extension` folder

On macOS, a `.command` file that was downloaded rather than built locally is
quarantined by Gatekeeper. If double-clicking is refused, right-click it and
choose Open, then confirm once.

## Warning about AI suggestions

Suggested answers can be confidently wrong. The model has no access to your
course material, your instructor's answer key, or any authoritative source. It
guesses from the question text and the choice labels alone.

Every filled answer gets a confidence score and a one-line explanation shown
directly beneath the question. Anything below 65 percent is marked low and
counted separately in the popup. Treat low-confidence answers as noise, and
verify high-confidence answers too.

## What it does and does not do

Does:

- Reads visible questions rendered as `role="radio"` or `role="checkbox"` on the
  current Google Forms page.
- Sends the question text, the choice labels, and a temporary per-run id to a
  server running on your own machine.
- Selects the suggested choice and writes a confidence note under the question.
- Clears the answers it filled in, on request.

Does not:

- Click, locate, or reference the Submit button. There is no selector in the
  source that can match one.
- Move to the next or previous form page.
- Read text inputs, email fields, names, cookies, tokens, passwords, browsing
  history, or any page content outside the question list items.
- Use `eval`, remote scripts, minified or obfuscated code, analytics, trackers,
  a CDN, or any third-party endpoint. The only outbound call to the public
  internet is made by the local server, to the OpenAI API.

## Permissions, exactly

`extension/manifest.json` declares two things and nothing else.

| Declaration | Value | Why |
| --- | --- | --- |
| `permissions` | `activeTab` | Lets the popup address the tab you are looking at after you click the toolbar icon. It grants nothing until that click and expires when you navigate away. |
| `host_permissions` | `http://127.0.0.1:8787/*` | Lets the popup call the answer server on your own machine. Loopback only, so the request cannot leave the computer. |

The content script is declared with a single match pattern:

```
https://docs.google.com/forms/d/e/*/viewform*
```

It is injected on those pages only, in the top frame only, and nowhere else.

Explicitly **not** requested: `<all_urls>`, `cookies`, `history`, `downloads`,
`storage`, `tabs`, `webRequest`, `scripting`. There is no background service
worker and no `web_accessible_resources` entry. `npm run audit` verifies all of
this mechanically and fails if any of it changes.

Note on `activeTab`: because the content script is declared in the manifest, it
loads on matching pages on its own. `activeTab` is what lets the popup then send
it a message for the current tab without the far broader `tabs` permission.

## Network endpoints

There are exactly two, and they are in different processes.

| From | To | Carries |
| --- | --- | --- |
| Extension popup | `http://127.0.0.1:8787/answer` | Question text, choice labels, temporary ids. Nothing else. |
| Extension popup | `http://127.0.0.1:8787/health` | Nothing. Reads back server status and whether a key exists, never the key. |
| Setup page | `http://127.0.0.1:8787/setup` | The key you paste, on its way to `.env` on your own disk. |
| Setup page | `http://127.0.0.1:8787/models` | Nothing. Reads back the model names the stored key can use. |
| Local server | `https://api.groq.com/openai/v1/chat/completions` | The questions, plus your Groq key as a bearer token. Only when Groq is selected. |
| Local server | `https://api.openai.com/v1/responses` | The questions, plus your OpenAI key as a bearer token. Only when OpenAI is selected. |

Exactly one of the two upstream rows is live at a time, decided by the provider
you pick on the setup page.

The extension never contacts the OpenAI API and never holds the key. The server
binds to `127.0.0.1` only, never `0.0.0.0`, and refuses any request that does not
arrive from loopback. It refuses requests whose `Origin` is a web page, so a site
you visit cannot reach it through your browser or forge a cross-site post to the
setup form. It also refuses any request whose `Host` header is not loopback,
which blocks DNS rebinding. All three refusals are covered by tests.

The setup page is served by the server, not by the extension. That is deliberate:
it means the key never enters the browser profile and the extension needs no
`storage` permission.

## Audit the source before you install it

Do not take this README's word for any of the above. Check it yourself, in this
order, from the project root:

```bash
node --version                      # must be 20 or newer
npm test                            # offline; no network access required
npm run audit                       # prints every permission and endpoint
```

Then read the four files that actually run in your browser. They are short and
commented:

```bash
cat extension/manifest.json         # the entire permission surface
cat extension/content.js            # everything that touches the page
cat extension/popup.js              # the only network call in the extension
cat server.js                       # the only file that sees your API key
```

Useful greps, all of which should come back empty for the extension folder:

```bash
grep -rn "eval\|new Function" extension/
grep -rn "all_urls\|cookies\|history\|webRequest" extension/
grep -rn "OPENAI_API_KEY" extension/
grep -rnE "https?://" extension/ | grep -v "127.0.0.1:8787"
```

`npm run audit` prints its own exclusions. It skips `scripts/audit.mjs`, which
necessarily contains the strings it searches for; `test/`, which contains
deliberate fake values such as `https://evil.example` that the tests assert are
rejected; and `.env`, which is supposed to hold your key and is both gitignored
and left out of the package. `.env.example` is still scanned, and a test asserts
the template never contains a real-looking key. Nothing that runs in the browser
or on the server is excluded.

## Setup in detail

The installer does all of this. Read on only if you want to do it by hand or
understand what the installer did.

### Provider and API key

Two providers ship. Pick one on the setup page; the choice is saved to `.env`.

| Provider | Cost | Default model | Where to get a key |
| --- | --- | --- | --- |
| Groq | Free tier, rate limited, no card required | `openai/gpt-oss-120b` | console.groq.com |
| OpenAI | Paid, needs credits | `gpt-4.1-mini` | platform.openai.com |

Each provider's key is stored under its own variable, `GROQ_API_KEY` and
`OPENAI_API_KEY`, so switching back and forth never loses the other one. The
setup page shows which providers already have a key saved.

The model field on the setup page is populated from the provider's own model
list, fetched with your stored key, filtered down to models that can actually
answer a question (speech, embedding, moderation and guard models are removed).
Providers retire model names without notice, so picking from a live list beats
typing one from documentation. If the list cannot be fetched the field falls back
to free text.

Provider selection resolves in this order: an explicit `PROVIDER` in `.env` wins;
otherwise whichever provider already has a key; otherwise Groq. An existing
single-provider setup is therefore never silently switched.

Groq is reached through its OpenAI-compatible chat completions endpoint in JSON
mode. JSON mode guarantees valid JSON but not the right shape, so the expected
schema is spelled out in the prompt and every field is re-validated afterwards by
the same `normalizeAnswers` used for OpenAI: unknown question ids and
out-of-range choice indexes are discarded rather than trusted. Markdown fences
around the reply, which JSON-mode models sometimes add, are stripped.

### API key

The key lives in the server process and in a `.env` file on your disk, written
with owner-only permissions (0600). It is never written into the extension,
never stored in the browser profile, never sent to the browser, and never
logged. `.env` is gitignored.

Easiest way, no terminal: start the server, open <http://127.0.0.1:8787/setup>,
paste the key into the form, click Save. The page shows whether a key is
configured, which model is in use, and the batch limit. It never displays a
stored key back to you.

By hand instead:

```bash
cp .env.example .env      # then edit OPENAI_API_KEY
```

### Start the local server

macOS and Linux:

```bash
npm start
```

If a `.env` exists the server picks the key up from it on the next save; to load
one into the environment up front:

```bash
set -a && source .env && set +a && npm start
```

Windows PowerShell:

```powershell
npm start
```

Or with the key in the environment:

```powershell
$env:OPENAI_API_KEY = "sk-your-key"
npm start
```

The server now starts without a key so the setup page is reachable. It refuses
to answer anything until a key exists, with an error saying where to add one.

Confirm it is up:

```bash
curl http://127.0.0.1:8787/health
```

Optional environment variables: `PROVIDER` (`groq` or `openai`), `MODEL`
(defaults to the selected provider's model), and `PORT` (defaults to 8787). Changing the port means editing the host permission in
`extension/manifest.json` and `SERVER_ORIGIN` in `extension/popup.js` to match.

To stop the server: Ctrl+C in its window, or double-click `Stop-Server.command`
on macOS.

### Load the extension in Brave

You do these steps yourself. Loading an unpacked extension is a change to your
browser's security posture, and it should be a deliberate act by the person who
owns the browser.

1. Audit the source first, as above.
2. Open `brave://extensions`.
3. Turn on **Developer mode**, top right.
4. Click **Load unpacked**.
5. Select the `extension/` folder from this project. Select the folder itself,
   not the zip and not the project root.
6. Pin the extension so the toolbar icon is visible.

To remove it later, use the Remove button on the same page. Turn Developer mode
back off when you are done if you do not otherwise use it.

## Using it

1. Start the local server (the installer does this) and make sure the popup's
   status dot is green.
2. Open one page of an authorized, ungraded Google Form.
3. Click the toolbar icon.
4. Tick the confirmation checkbox. The buttons stay disabled until you do.
5. Click **Answer visible questions**.
6. Read the status line: how many questions were processed, and how many came
   back below 65 percent confidence.
7. Review every answer against the notes shown under each question.
8. Submit the form yourself, if submitting is appropriate at all.

**Clear filled answers** deselects the choices this extension selected on the
current page and removes its notes.

## Multi-page forms

Google Forms splits long forms into sections, and only one section is in the DOM
at a time. This extension does not navigate between sections, by design.

Open a page, run the extension, review the answers, move to the next page
yourself, and run it again. Each run is independent: question ids are generated
fresh and are not stored anywhere.

## Batching and long forms

Fifteen questions per request. That ceiling is enforced in two places: the popup
splits the page into batches of fifteen before sending, and the server rejects an
oversized batch with HTTP 400 regardless of what asked.

A page with 100 questions is handled in one click. The popup sends seven
consecutive requests and fills each batch in as it arrives, so the status line
reads "batch 3 of 7" while it works. Because answers land per batch rather than
at the end, a failure part way through leaves everything before it on the page,
and the status says exactly where it stopped.

Transient failures are retried up to four times. The wait is whatever the
provider asked for in its `Retry-After` header, or the delay quoted in its error
body, whichever it gave; failing that it backs off exponentially from five
seconds. A fixed short delay walks straight back into the same rate limit, which
is exactly what happened on the first real run against the Groq free tier.

Batches are also spaced about a second apart, so a long form does not arrive as
one burst.

Only failures the server marks as transient are retried: rate limiting and
upstream errors. A bad key, an unknown model, or an exhausted credit balance
fails immediately, because retrying those wastes time.

If a batch still fails after all retries, the run continues to the next batch
rather than abandoning the form. The summary names the batches that did not
complete. Running again re-answers the whole page, so blanks get filled.

This is per page. Multi-section forms still need you to open each section and run
the extension again, by design.

## When something goes wrong

Errors from the OpenAI API are translated into plain language before they reach
the popup. The raw response body is never shown, so nothing from your questions
can be echoed back through an error message. What you may see:

| Message | Cause |
| --- | --- |
| The account has no credits left | Billing, not the extension. Add credits, or switch provider on the setup page. |
| rate limit reached | Too many requests too quickly. Retried automatically, twice. |
| rejected the API key | Wrong or revoked key. Re-enter it on the setup page. |
| does not recognise the model | The model name is not available to your account. Pick another on the setup page. |
| Local server unreachable | The server is not running. Start it, or run the installer again. |
| Cannot reach the page | Not a Google Forms viewform page, or the page needs a reload. |

The server log carries the same information plus counts, never content:

```bash
tail -20 server.log
```

## Known Google Forms DOM limitations

Google Forms ships obfuscated, frequently changing markup with no stable class
names. This extension reads ARIA roles, which are the most durable handles
available, but the following are real and expected limits:

- **Question types.** Only `role="radio"` and `role="checkbox"` items are read.
  Short answer, paragraph, dropdown, linear scale, grid, date, time, and file
  upload questions are skipped. Dropdowns and grids in particular use listbox
  and grid structures that this extension deliberately does not touch.
- **Checkbox questions.** Multi-select questions are extracted, but the model is
  asked for a single index, so only one box is ticked. Questions needing several
  boxes need manual completion.
- **Choice labels.** Labels are read from `aria-label`, falling back to
  `data-value` and then text content. Image-only choices and choices whose text
  is rendered outside the labelled element extract as empty or partial strings,
  which degrades suggestion quality.
- **Question text.** Read from the item's `role="heading"` element. Supporting
  descriptions, images, and attached media are not sent, so questions that
  depend on an image cannot be answered meaningfully.
- **Required-question markers.** The asterisk on required questions is part of
  the heading text and is sent through as-is. Harmless, occasionally odd-looking
  in an explanation.
- **Deselecting radios.** Clear works by clicking a selected choice again, which
  is how Google Forms deselects. If Google changes that behaviour, Clear will
  silently stop deselecting radios. Notes are still removed.
- **Length caps.** Question text is capped at 600 characters, choice labels at
  300, and choices at 20 per question. Longer content is truncated before it
  leaves the page.
- **Markup drift.** Google can change this DOM without notice. When extraction
  silently returns zero questions on a form that clearly has them, the role
  selectors in `extension/content.js` are the place to look.

## Project layout

```
LICENSE                    MIT.
Install-macOS.command      Double-click setup for macOS.
Install-Windows.bat        Double-click setup for Windows.
Stop-Server.command        Stops the local server on macOS.
extension/manifest.json    Permission surface. Two declarations, nothing else.
extension/popup.html       Popup markup, including the confirmation gate.
extension/popup.css        Popup styles. No external fonts or assets.
extension/popup.js         Orchestration and the only network calls in the extension.
extension/content.js       Page reading and choice selection. No network access.
server.js                  Local server, provider registry, API keys. No dependencies.
setup.html                 Provider picker, key entry, and status. Served at /setup.
package.json               Scripts and the Node 20+ engine requirement.
.env.example               Key template. Copy to .env, which is gitignored.
test/                      Offline tests. 97 of them, no network required.
scripts/audit.mjs          Permission and endpoint scanner.
scripts/package.mjs        Runs checks, then builds the zip and prints its hash.
```

## Development

```bash
npm test        # offline test suite
npm run audit   # permission and endpoint report
npm run package # syntax check, manifest check, tests, audit, then zip
```

`npm run package` refuses to build if any step fails.

## Sharing this

The packaged zip is safe to hand to someone else. `npm run package` refuses to
build one that is not.

After the tests and the permission audit pass, packaging extracts the archive it
just built and sweeps it for:

- `.env`, `server.log`, `node_modules/`, and any `.pem`, which must never be in
  the bundle
- credentials by shape: `sk-proj-`, `sk-ant-`, `gsk_`, `AIza`, `gh[pousr]_`,
  `xox[baprs]-`, `AKIA`, long opaque `sk-` strings, and private key blocks
- the exact secret values sitting in your own `.env` at build time, so the check
  is not merely guessing what a key looks like
- absolute home directory paths

If anything matches, the zip is **deleted** rather than shipped and the build
fails naming the file. This was verified by deliberately planting a Groq-shaped
key in the README and confirming the build refused to produce an archive.

The test fixtures in `test/` do contain fake key strings: an `sk-` prefix
followed by lowercase filler. They are deliberate, used to assert that keys are
never echoed back into a response or an error message, and they match no real
credential prefix. Writing a realistic-looking one here would trip the project's
own scanner, which is the behaviour you want from it.

What the recipient still supplies themselves: their own API key, entered on
their own setup page, written to their own `.env`, which is gitignored and never
packaged.

## License

MIT. See [LICENSE](LICENSE).

The copyright line reads "choda". Change it if you want a different name on it.
