# Menti Solver

Answers Mentimeter quiz questions automatically. It reads the question and options straight from the menti.com page, asks a fast LLM (Groq, optionally raced against Cerebras) for the correct option, and clicks it, typically in under a second.

There are two editions that share the same detection and answering logic:

| | Chrome extension | Python edition |
|---|---|---|
| Runs in | Your normal Chrome | A Chrome window opened by Python |
| Setup | Load folder, guided key setup | Python + pip install |
| Controls | Popup with on/off switch, shortcut, settings page | `.env` file |
| Answers shown | On-page card + popup | On-page box + terminal |
| Best for | Everyday use, sharing with friends | Tinkering, logging, extending in Python |

A Tampermonkey userscript version is also included in `userscript/` if you prefer that.

---

## How it works

1. **Detect.** A `MutationObserver` watches the page and fires the moment answer options appear, with no polling or screenshots. Options are found as a group of 2–8 large clickable elements with text; the question is the largest heading on the page.
2. **Ask.** The question and numbered options go to Groq (`openai/gpt-oss-20b` by default). If a Cerebras key is set, both are asked at the same time and the first valid answer wins. Connections are kept warm between questions to skip the TLS handshake.
3. **Click.** The model replies with an option number, and that element is clicked inside the page. There's no mouse movement and no OS permissions are needed.

```
menti.com page ──► detect options ──► Groq ┐
                                           ├─► first answer ──► click
                                  Cerebras ┘
```

---

## 1. Get API keys

- **Groq (required):** sign up at [console.groq.com](https://console.groq.com), then go to API Keys → Create. Free tier.
- **Cerebras (optional backup):** sign up at [cloud.cerebras.ai](https://cloud.cerebras.ai) with email or GitHub; no card is needed. The free tier has tight per-minute limits, which is fine for a quiz.

> Never commit your keys. The extension stores them in your browser; the Python edition reads them from `python/.env`, which is git-ignored.

## 2. Download the project

Either clone it:

```bash
git clone https://github.com/YOUR_USERNAME/menti-solver.git
cd menti-solver
```

or on GitHub click **Code → Download ZIP** and unzip it.

---

## Chrome extension

### Install (you or a friend)

1. Download **`menti-solver-extension-vX.Y.Z.zip`** from this repo's [Releases](../../releases) page and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the unzipped `extension` folder.
4. A setup page opens automatically: get a free Groq key, paste it, pin the extension. About a minute.

Everyone should use **their own** Groq key. Keys are free, and if friends share one key they share one rate limit, which runs out exactly when everyone in the same quiz is asking at once.

**Updating:** download the new zip from Releases, replace the old `extension` folder with the new one, then click ↻ on the Menti Solver card in `chrome://extensions`. Quiz tabs that are already open pick up the new version automatically, so there's no need to refresh them. (Coming from v2.0.0, refresh open menti.com tabs once.)

**Permissions it asks for:** storage (your keys and settings, kept in this browser), access to api.groq.com and api.cerebras.ai (to get answers), and access to menti.com plus "scripting" (to run on quiz pages, including tabs that were already open when you installed or updated).

### Using it

- **Toolbar popup**: a large on/off switch, "Answer and click" or "Show answer only", and the last answer with its time.
- **Toolbar badge**: `ON`, `OFF`, or `!` when no key is set.
- **Shortcut**: `Alt+Shift+M` turns it on or off from any tab (change it at `chrome://extensions/shortcuts`).
- **On the quiz page**: a small glass pill in the bottom-right shows the status. It opens into a card with the question, answer and time after every answer, or when you hover it, and has its own on/off switch.
- **Settings**: keys are checked as you paste them, and models and timeout live under Advanced. A test button sends one sample question to each provider.

## Python edition

Needs Python 3.10+ and Google Chrome (or it can download its own Chromium).

**macOS / Linux**

```bash
cd menti-solver/python
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # then open .env and paste your key(s)
python menti_solver.py
```

**Windows (PowerShell)**

```powershell
cd menti-solver\python
py -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env      # then open .env and paste your key(s)
python menti_solver.py
```

The script checks your keys, then opens a Chrome window at menti.com. **Join the quiz in that window.** Answers are printed in the terminal and clicked automatically:

```
[612 ms · groq] What is 17 × 6?
   -> 3. 102
```

Close the window or press Ctrl+C to quit.

If you don't have Chrome installed, set `BROWSER_CHANNEL=` (empty) in `.env` and run `playwright install chromium` once.

---

## Keyboard shortcuts

| Keys | Where | Action |
|---|---|---|
| Alt+Shift+M | Extension, any tab | Turn on / off |
| Option+P (Mac) / Alt+P | Python edition | Pause / resume |
| Option+D (Mac) / Alt+D | menti.com page | Copy page structure for debugging (Python: saved to `python/debug_structure.html`) |

## Configuration

| Setting | Extension | Python `.env` | Default |
|---|---|---|---|
| Groq model | Settings > Advanced | `GROQ_MODEL` | `openai/gpt-oss-20b` |
| Cerebras model | Settings > Advanced | `CEREBRAS_MODEL` | `gpt-oss-120b` |
| Timeout per request | Settings > Advanced (ms) | `TIMEOUT_SECONDS` | 2.5 s |
| Auto-click | Popup or Settings | `AUTO_CLICK` | on |
| Browser | n/a | `BROWSER_CHANNEL` | `chrome` |

Use `openai/gpt-oss-120b` on Groq if accuracy matters more than a few hundred milliseconds.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| No pill appears on menti.com | Extension: reload it in `chrome://extensions` and refresh the tab. Python: make sure you're using the window it opened. |
| Badge shows `!` / "Needs an API key" | Extension: open the popup and click Set up. Python: check `python/.env` exists and has `GROQ_API_KEY`. |
| Pill says "Refresh this page" | The extension was updated while this tab was open and couldn't take over automatically. Refresh the tab once. |
| Pill disappeared | The solver is off. Turn it on from the popup or with Alt+Shift+M. |
| Shows the answer but doesn't click | Press Option/Alt+D and inspect the structure; the options may use unusual elements. |
| Box never says "Thinking…" | Detection missed the options. Use Option/Alt+D to see what was detected. |
| `HTTP 429` | Rate limit reached. Wait a minute, or add a second provider. |
| `HTTP 404` / model not found | The provider retired that model. Pick a current one from their model list. |
| Python: `No module named ...` | Activate the venv and run `pip install -r requirements.txt` again. |

## Project structure

```
menti-solver/
├── extension/            Chrome extension (Manifest V3)
│   ├── manifest.json
│   ├── background.js     API calls, provider race, key checks, badge, shortcut
│   ├── content.js        detection, clicking, on-page glass pill/card
│   ├── popup.*           toolbar popup with the on/off switch
│   ├── welcome.*         first-run setup
│   ├── options.*         settings page
│   ├── shared.js, ui.css, pages.css   shared components and design tokens
│   └── icons/
├── python/               Python edition (Playwright)
│   ├── menti_solver.py   browser launch, API race over HTTP/2, terminal output
│   ├── detector.js       page-side detection, injected by Playwright
│   ├── requirements.txt
│   └── .env.example
├── userscript/
│   └── menti_solver.user.js   Tampermonkey version
├── LICENSE
└── README.md
```

## Changelog

**v2.0.1**
- Open quiz tabs keep working after the extension is updated or reloaded.
- Routine errors (rate limits, timeouts) show in the on-page card instead of filling `chrome://extensions` > Errors.

**v2.0.0**
- Toolbar popup with an on/off switch, answer-and-click or show-only mode, and the last answer.
- Toolbar badge, and the Alt+Shift+M shortcut.
- First-run setup page, redesigned settings with key checking, and an on-page glass pill that opens into a card.

## Disclaimer

Built as a personal project for exploring browser automation and low-latency LLM inference. Automating answers may break Mentimeter's terms of use, and using it on graded quizzes is cheating. Use it on your own practice quizzes.
