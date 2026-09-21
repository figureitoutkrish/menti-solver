#!/usr/bin/env python3
"""
Menti Solver - Python edition.

Opens a Chrome window controlled by Playwright. Join your quiz in that window as usual.
detector.js is injected into the page: it spots the question and options the instant they
appear and hands them to Python. Python races Groq and Cerebras over warm HTTP/2
connections, returns the option number, and the page clicks it.

No screenshots, no OCR, no macOS Screen Recording / Accessibility permissions.
Quit by closing the browser window or pressing Ctrl+C.
"""

import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv
from playwright.async_api import Error as PlaywrightError
from playwright.async_api import async_playwright

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")


def env_bool(name: str, default: bool) -> bool:
    return os.getenv(name, str(default)).strip().lower() not in ("0", "false", "no", "off")


# ---------------- config (override in .env) ----------------
GROQ_KEY = os.getenv("GROQ_API_KEY", "").strip()
CEREBRAS_KEY = os.getenv("CEREBRAS_API_KEY", "").strip()
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-20b").strip()
CEREBRAS_MODEL = os.getenv("CEREBRAS_MODEL", "gpt-oss-120b").strip()
TIMEOUT = float(os.getenv("TIMEOUT_SECONDS", "2.5"))
AUTO_CLICK = env_bool("AUTO_CLICK", True)
START_URL = os.getenv("START_URL", "https://www.menti.com").strip()
BROWSER_CHANNEL = os.getenv("BROWSER_CHANNEL", "chrome").strip()  # "chrome", "msedge", or "" for bundled Chromium
PROFILE_DIR = HERE / ".browser-profile"

PROVIDERS = [
    p for p in (
        {"name": "groq", "base": "https://api.groq.com/openai/v1", "key": GROQ_KEY,
         "model": GROQ_MODEL, "reasoning": True},
        {"name": "cerebras", "base": "https://api.cerebras.ai/v1", "key": CEREBRAS_KEY,
         "model": CEREBRAS_MODEL, "reasoning": True},
    ) if p["key"] and not p["key"].startswith("your_")
]

SYSTEM = "You answer multiple-choice quiz questions. Output only the option number."

client: httpx.AsyncClient  # created in main()


def build_prompt(question: str, options: list[str]) -> str:
    lines = "\n".join(f"{i}. {t}" for i, t in enumerate(options, 1))
    return (f"Question: {question or '(not shown)'}\nOptions:\n{lines}\n\n"
            "Reply with ONLY the number of the correct option.")


# ---------------- AI ----------------
async def call_provider(p: dict, question: str, options: list[str]) -> tuple[int, str]:
    body = {
        "model": p["model"],
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": build_prompt(question, options)},
        ],
        "temperature": 0,
        "max_tokens": 512,
    }
    if p["reasoning"]:
        body["reasoning_effort"] = "low"
    headers = {"Authorization": f"Bearer {p['key']}"}
    url = f"{p['base']}/chat/completions"

    try:
        r = await client.post(url, json=body, headers=headers)
        if r.status_code == 400 and p["reasoning"]:  # model doesn't support reasoning_effort
            p["reasoning"] = False
            body.pop("reasoning_effort", None)
            r = await client.post(url, json=body, headers=headers)
    except httpx.TimeoutException:
        raise RuntimeError(f"{p['name']} timeout") from None
    except httpx.HTTPError as e:
        raise RuntimeError(f"{p['name']} network error: {e}") from None

    if r.status_code != 200:
        raise RuntimeError(f"{p['name']} HTTP {r.status_code}: {r.text[:150]}")

    content = r.json()["choices"][0]["message"].get("content") or ""
    m = re.search(r"\d+", content)
    n = int(m.group()) if m else 0
    if 1 <= n <= len(options):
        return n, p["name"]
    raise RuntimeError(f"{p['name']} bad reply: {content[:80]!r}")


async def first_success(coros) -> tuple[int, str]:
    """Run all coroutines at once, return the first successful result, cancel the rest."""
    tasks = [asyncio.create_task(c) for c in coros]
    errors = []
    try:
        for fut in asyncio.as_completed(tasks):
            try:
                return await fut
            except Exception as e:  # noqa: BLE001
                errors.append(str(e))
    finally:
        for t in tasks:
            t.cancel()
    raise RuntimeError(" | ".join(errors))


async def solve(question: str, options: list[str]) -> tuple[int, str]:
    last = None
    for _ in range(2):  # one retry if every provider fails
        try:
            return await first_success(call_provider(p, question, options) for p in PROVIDERS)
        except RuntimeError as e:
            last = e
    raise last


async def warm(verbose: bool = False) -> None:
    """Open (or keep open) the TLS connection to each provider and check the keys."""
    for p in PROVIDERS:
        try:
            r = await client.get(f"{p['base']}/models", headers={"Authorization": f"Bearer {p['key']}"})
            if verbose:
                state = "OK" if r.status_code == 200 else f"HTTP {r.status_code} (check the key)"
                print(f"  {p['name']:<9} {p['model']:<22} {state}")
        except httpx.HTTPError as e:
            if verbose:
                print(f"  {p['name']:<9} unreachable: {e}")


async def keepalive() -> None:
    while True:
        await asyncio.sleep(25)
        await warm()


# ---------------- page bridge ----------------
async def on_found(payload: dict) -> dict:
    question = payload.get("question") or ""
    options = payload.get("options") or []
    t0 = time.perf_counter()
    try:
        n, provider = await solve(question, options)
    except Exception as e:  # noqa: BLE001
        print(f"\n[error] {question[:80]}\n   {e}")
        return {"error": str(e)}
    ms = int((time.perf_counter() - t0) * 1000)
    print(f"\n[{ms} ms · {provider}] {question}\n   -> {n}. {options[n - 1]}")
    return {"n": n, "provider": provider, "ms": ms}


async def on_dump(html: str) -> None:
    path = HERE / "debug_structure.html"
    path.write_text(html, encoding="utf-8")
    print(f"\n[debug] page structure saved to {path}")


async def launch(pw):
    kwargs = dict(user_data_dir=str(PROFILE_DIR), headless=False, no_viewport=True,
                  args=["--start-maximized"])
    if BROWSER_CHANNEL:
        try:
            return await pw.chromium.launch_persistent_context(channel=BROWSER_CHANNEL, **kwargs)
        except PlaywrightError as e:
            print(f"Couldn't start '{BROWSER_CHANNEL}' ({str(e).splitlines()[0]}). Trying bundled Chromium...")
    return await pw.chromium.launch_persistent_context(**kwargs)


# ---------------- main ----------------
async def main() -> None:
    global client
    if not PROVIDERS:
        sys.exit("No API key found. Copy .env.example to .env and add GROQ_API_KEY (and optionally CEREBRAS_API_KEY).")

    client = httpx.AsyncClient(
        http2=True,
        timeout=httpx.Timeout(TIMEOUT, connect=TIMEOUT),
        limits=httpx.Limits(max_keepalive_connections=10, keepalive_expiry=120),
    )

    print("Menti Solver (Python edition)")
    print("Checking providers:")
    await warm(verbose=True)

    detector = (HERE / "detector.js").read_text(encoding="utf-8")
    cfg = {"autoClick": AUTO_CLICK, "providers": [p["name"] for p in PROVIDERS]}

    async with async_playwright() as pw:
        ctx = await launch(pw)
        await ctx.expose_function("__mentiFound", on_found)
        await ctx.expose_function("__mentiDump", on_dump)
        await ctx.add_init_script(f"window.__MENTI_CFG = {json.dumps(cfg)};\n{detector}")

        closed = asyncio.Event()
        ctx.on("close", lambda *_: closed.set())

        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await page.goto(START_URL)
        print(f"\nBrowser open at {START_URL}. Join your quiz there.")
        print(f"Auto-click: {'on' if AUTO_CLICK else 'off'}. Close the browser window or press Ctrl+C to quit.")

        keep = asyncio.create_task(keepalive())
        try:
            await closed.wait()
        finally:
            keep.cancel()

    await client.aclose()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nBye.")
