# Menti Solver

Answers Mentimeter quiz questions automatically. It reads the question and options straight from the menti.com page, asks a fast LLM (Groq, optionally raced against Cerebras) for the correct option, and clicks it, typically in under a second.

There are two editions that share the same detection and answering logic:

| | Chrome extension | Python edition |
|---|---|---|
| Runs in | Your normal Chrome | A Chrome window opened by Python |
| Setup | Load folder, paste key | Python + pip install |
| Answers shown | On-page box + browser console | On-page box + terminal |
| Best for | Everyday use | Tinkering, logging, extending in Python |

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

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and select the `extension/` folder.
3. Pin **Menti Solver** from the puzzle-piece menu and click its icon. The settings page opens.
4. Paste your Groq key (and Cerebras key if you have one), then click **Save & test keys**. You should see ✅ for each provider.
5. Open [menti.com](https://www.menti.com) and join a quiz. A small box in the bottom-right should say **Menti Solver ready**.

When options appear, the box shows **Thinking…**, then the answer and the time in ms, and the answer is clicked.

**Updating:** after changing any file, click the reload ↻ icon on the extension card in `chrome://extensions`, then refresh the menti.com tab.

---

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

## Controls (both editions)

| Keys | Action |
|---|---|
| Option+P (Mac) / Alt+P | Pause / resume |
| Option+D (Mac) / Alt+D | Copy page structure for debugging (Python: saved to `python/debug_structure.html`) |

## Configuration

| Setting | Extension | Python `.env` | Default |
|---|---|---|---|
| Groq model | settings page | `GROQ_MODEL` | `openai/gpt-oss-20b` |
| Cerebras model | settings page | `CEREBRAS_MODEL` | `gpt-oss-120b` |
| Timeout per request | settings page (ms) | `TIMEOUT_SECONDS` | 2.5 s |
| Auto-click | settings page | `AUTO_CLICK` | on |
| Browser | n/a | `BROWSER_CHANNEL` | `chrome` |

Use `openai/gpt-oss-120b` on Groq if accuracy matters more than a few hundred milliseconds.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| No box appears on menti.com | Extension: reload it in `chrome://extensions` and refresh the tab. Python: make sure you're using the window it opened. |
| "No API key set" | Extension: click the icon and save a key. Python: check `python/.env` exists and has `GROQ_API_KEY`. |
| "Extension was reloaded" | Refresh the menti.com tab. |
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
│   ├── background.js     API calls, provider race, connection warm-up
│   ├── content.js        detection, overlay, clicking
│   ├── options.html      settings page
│   └── options.js
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

## Disclaimer

Built as a personal project for exploring browser automation and low-latency LLM inference. Automating answers may break Mentimeter's terms of use, and using it on graded quizzes is cheating. Use it on your own practice quizzes.
