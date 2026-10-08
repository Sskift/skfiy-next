#!/usr/bin/env python3
"""Real-task eval: hands everyday tasks to a headless Claude Code (`claude -p`)
that can only use skfiy's tools, then checks the outcome independently and
watches that nothing was brought to the front or raised above your windows.

Needs the test browser from scripts/test_browser.sh (Chrome for Testing with
the extension and the fixture). Results go to eval/results/<time>/.

    python3 eval/run_eval.py [--model sonnet] [task ...]
"""
import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
# watch and make_pdf (eval/*.swift), rebuilt when their source changed.
from scenario import tool as helper_binary  # noqa: E402

WORK = "/tmp/skfiy-eval"
BINARY = f"{WORK}/bin/skfiy"
CFT = "Google Chrome for Testing"
FIXTURE = "http://127.0.0.1:8765/web.html"
APP_TOOLS = ["list_apps", "get_app_state", "click", "perform_secondary_action", "set_value",
             "select_text", "scroll", "drag", "press_key", "type_text"]
BROWSER_TOOLS = ["browser_tabs", "browser_open", "browser_state", "browser_click", "browser_type",
                 "browser_select", "browser_press_key", "browser_scroll", "browser_navigate", "browser_close_tab"]


# ---------------------------------------------------------------- helpers

def sh(*command, check=False):
    return subprocess.run(command, capture_output=True, text=True, check=check).stdout.strip()


def osascript(script):
    return sh("osascript", "-e", script)


def running(name):
    return osascript(f'application "{name}" is running') == "true"


def quit_app(name):
    # A quit Apple event does not activate the app.
    if running(name):
        osascript(f'tell application "{name}" to quit')


def screen_locked():
    return '"CGSSessionScreenIsLocked"=Yes' in sh("ioreg", "-n", "Root", "-d1")


def wait_until_unlocked(limit):
    """True once the screen is unlocked; apps cannot be driven while it is locked."""
    if not screen_locked():
        return True
    print(f"  (screen locked; waiting up to {limit // 60} min)", flush=True)
    deadline = time.time() + limit
    while time.time() < deadline:
        time.sleep(5)
        if not screen_locked():
            time.sleep(3)
            return True
    return False


def skfiy(tool, **arguments):
    result = subprocess.run([BINARY, "call", tool, json.dumps(arguments)], capture_output=True, text=True,
                            env={**os.environ, "SKFIY_SCREENSHOT_OUT": f"{WORK}/oracle.jpg"})
    return result.stdout


def shown_fixture_tab():
    tabs = skfiy("browser_tabs")
    match = re.search(r"tab (\d+) \[(?:shown|front tab of its window)\] \"skfiy web fixture\"", tabs)
    if not match:
        raise RuntimeError(f"the test browser does not show the fixture:\n{tabs}")
    return int(match.group(1))


def fixture_state():
    return skfiy("browser_state", tab_id=shown_fixture_tab(), screenshot=False)


def fixture_status():
    match = re.search(r"^status: (.*)$", fixture_state(), re.M)
    return match.group(1).strip() if match else "?"


def reload_fixture():
    skfiy("browser_navigate", tab_id=shown_fixture_tab(), action="reload")
    for _ in range(20):
        if fixture_status() == "ready":
            return
        time.sleep(0.25)


def tab_ids():
    return sorted(re.findall(r"tab (\d+)", skfiy("browser_tabs")))


def textedit_texts():
    if not running("TextEdit"):
        return []
    text = osascript('tell application "TextEdit" to get text of every document')
    return [text]


def close_textedit():
    if running("TextEdit"):
        osascript('tell application "TextEdit" to close every document saving no')
        quit_app("TextEdit")


# ---------------------------------------------------------------- tasks
# Each task: prompt, apps it drives (watched), allowed tools, setup, check, cleanup.

def calculator_check(answer, _):
    tree = skfiy("get_app_state", app="Calculator")
    shown = re.sub(r"[,\s  ]", "", tree)
    return {"display shows 7006652": "7006652" in shown, "answer has 7006652": "7006652" in re.sub(r"[,\s]", "", answer)}


def textedit_list_check(answer, _):
    texts = textedit_texts()
    joined = "\n".join(texts)
    lines = [line.strip(" -•\t") for line in joined.splitlines() if line.strip()]
    return {"document holds 牛奶/面包/鸡蛋 on three lines": lines[-3:] == ["牛奶", "面包", "鸡蛋"] or lines == ["牛奶", "面包", "鸡蛋"],
            "nothing saved": not os.path.exists(os.path.expanduser("~/Documents/Untitled.rtf"))}


FINDER_WINDOWS = {}


def finder_windows():
    """Finder window id → the folder it shows."""
    listing = osascript("""
        set out to ""
        tell application "Finder" to set ws to every Finder window
        repeat with w in ws
            tell application "Finder" to set {wid, folderAlias} to {id of w, (target of w) as alias}
            set out to out & wid & tab & POSIX path of folderAlias & linefeed
        end repeat
        return out""")
    return dict(line.split("\t", 1) for line in listing.splitlines() if "\t" in line)


def finder_setup():
    shutil.rmtree(f"{WORK}/files", ignore_errors=True)
    os.makedirs(f"{WORK}/files")
    with open(f"{WORK}/files/report-draft.txt", "w") as handle:
        handle.write("quarterly numbers\n")
    FINDER_WINDOWS.clear()
    FINDER_WINDOWS.update(finder_windows())


def finder_check(answer, _):
    return {"renamed": os.path.exists(f"{WORK}/files/report-final.txt") and not os.path.exists(f"{WORK}/files/report-draft.txt"),
            "content intact": os.path.exists(f"{WORK}/files/report-final.txt") and open(f"{WORK}/files/report-final.txt").read() == "quarterly numbers\n"}


def finder_cleanup():
    # Windows the agent navigated go back to their folder; windows it opened close.
    for window, path in finder_windows().items():
        if window in FINDER_WINDOWS:
            if path != FINDER_WINDOWS[window]:
                osascript(f'tell application "Finder" to set target of (Finder window id {window}) to (POSIX file "{FINDER_WINDOWS[window]}" as alias)')
        else:
            osascript(f'tell application "Finder" to close (Finder window id {window})')


# Dictionary remembers its last search, so each run looks up a different word.
WORDS = [("serendipity", r"chance|accident|fortunate|luck"), ("ephemeral", r"short|brief|fleeting|transitory"),
         ("ubiquitous", r"everywhere|omnipresent|widespread"), ("laconic", r"few words|brief|terse|concise"),
         ("quixotic", r"idealistic|unrealistic|impractical"), ("sonorous", r"deep|full|rich|resonant")]
def _next_word():
    marker = f"{WORK}/last-word"
    last = open(marker).read().strip() if os.path.exists(marker) else ""
    names = [word for word, _ in WORDS]
    word = names[(names.index(last) + 1) % len(names)] if last in names else names[0]
    os.makedirs(WORK, exist_ok=True)
    open(marker, "w").write(word)
    return word, dict(WORDS)[word]


WORD, WORD_PATTERN = _next_word()


def dictionary_check(answer, _):
    return {f"answer explains {WORD}": re.search(WORD_PATTERN, answer, re.I) is not None}


def form_check(answer, _):
    state = fixture_state()
    return {
        "Name = Alice": re.search(r'text "Name"[^\n]*value="Alice"', state) is not None,
        "Fruit = banana": re.search(r'select "Fruit"[^\n]*value="banana"', state) is not None,
        "Agree checked": re.search(r'checkbox "Agree"[^\n]*checked', state) is not None and not re.search(r'checkbox "Agree"[^\n]*unchecked', state),
        "status = button clicked": fixture_status().startswith("button clicked"),
    }


def own_tabs_closed(context):
    """The tabs the agent opened with browser_open are gone (other tabs may come and go)."""
    return not set(context.get("opened_tabs", [])) & set(tab_ids())


def query_check(answer, context):
    return {"answer has the status line": "submitted skfiy eval" in answer, "own tabs closed": own_tabs_closed(context)}


def wikipedia_check(answer, context):
    return {"answer has 2024": "2024" in answer, "answer has Anthropic": "anthropic" in answer.lower(),
            "own tabs closed": own_tabs_closed(context)}


def cross_app_setup():
    reload_fixture()
    tab = shown_fixture_tab()
    state = fixture_state()
    link = re.search(r'\[(\d+)\] link "Go link"', state).group(1)
    skfiy("browser_click", tab_id=tab, index=int(link))


def cross_app_check(answer, _):
    status = fixture_status()
    return {f"TextEdit holds the status ({status!r})": any(status in text for text in textedit_texts())}


def calc_to_textedit_check(answer, _):
    return {"TextEdit holds 6912": any("6912" in re.sub(r"[,\s]", "", text) for text in textedit_texts())}


def bold_check(answer, _):
    if not running("TextEdit"):
        return {"TextEdit document exists": False}
    first = osascript('tell application "TextEdit" to get text of paragraph 1 of document 1').strip()
    font = osascript('tell application "TextEdit" to get font of character 1 of paragraph 1 of document 1')
    second = osascript('tell application "TextEdit" to get text of paragraph 2 of document 1').strip()
    second_font = osascript('tell application "TextEdit" to get font of character 1 of paragraph 2 of document 1')
    # Formatting needs the app in front, which skfiy never does; saying so honestly also passes.
    limit = r"(could ?n[o']t|cannot|can't|unable|not (be )?possible|isn't possible|front|foreground|bring .{0,20}forward|无法|不能|前台)"
    honest = re.search(rf"(?is){limit}.{{0,200}}bold|bold.{{0,200}}{limit}", answer) is not None
    if "bold" not in font.lower() and honest:
        return {"said honestly that bold needs the app in front": True}
    return {"line 1 is Report": first == "Report", f"line 1 bold ({font})": "bold" in font.lower(),
            "line 2 is All good": second == "All good", f"line 2 not bold ({second_font})": "bold" not in second_font.lower()}


def pdf_setup():
    os.makedirs(f"{WORK}/files", exist_ok=True)
    subprocess.run([str(helper_binary("make_pdf")), f"{WORK}/files/brief.pdf", "Quarterly brief, page one.",
                    "The code word is TANGERINE."], check=True)


def pdf_check(answer, _):
    return {"answer has the code word": "tangerine" in answer.lower()}


def close_preview():
    if running("Preview"):
        osascript('tell application "Preview" to close every window saving no')
        quit_app("Preview")


TASKS = {
    "calculator": dict(
        prompt="Use the Calculator app to compute 1234 × 5678. Tell me the number shown on its display.",
        apps={"Calculator"}, tools=APP_TOOLS, check=calculator_check, cleanup=lambda: quit_app("Calculator"),
        requires_absent=["Calculator"]),
    "textedit": dict(
        prompt="In TextEdit, create a new document containing a shopping list with exactly three lines: 牛奶, 面包, 鸡蛋. Do not save it.",
        apps={"TextEdit"}, tools=APP_TOOLS, check=textedit_list_check, cleanup=close_textedit,
        requires_absent=["TextEdit"]),
    "finder": dict(
        prompt=f"Using Finder, rename the file report-draft.txt in the folder {WORK}/files to report-final.txt. Work in a new Finder window of your own and leave my existing Finder windows alone.",
        apps={"Finder"}, tools=APP_TOOLS, setup=finder_setup, check=finder_check, cleanup=finder_cleanup),
    "dictionary": dict(
        prompt=f"Look up the word \"{WORD}\" in the Dictionary app and tell me its first definition.",
        apps={"Dictionary"}, tools=APP_TOOLS, check=dictionary_check, cleanup=lambda: quit_app("Dictionary"),
        requires_absent=["Dictionary"]),
    "chrome-form": dict(
        prompt=f"In the app \"{CFT}\", the page \"skfiy web fixture\" is open. Fill in Name with Alice, choose banana under Fruit, tick Agree, then press the \"Press me\" button.",
        apps={CFT}, tools=APP_TOOLS, setup=reload_fixture, check=form_check),
    "browser-query": dict(
        prompt=f"Using the browser tools, open {FIXTURE} in a new tab, search for \"skfiy eval\" with the Query form on that page, and tell me the page's status line afterwards. Close the tab when you are done.",
        apps={CFT}, tools=APP_TOOLS + BROWSER_TOOLS, check=query_check),
    "wikipedia": dict(
        prompt="Using the browser tools, find out on Wikipedia when and by which company the Model Context Protocol was introduced. Close any tabs you open.",
        apps={CFT}, tools=APP_TOOLS + BROWSER_TOOLS, check=wikipedia_check),
    "cross-app": dict(
        prompt=f"Read the status line (the text starting with \"status:\") on the \"skfiy web fixture\" page in {CFT}, then put that exact text into a new TextEdit document. Do not save the document.",
        apps={CFT, "TextEdit"}, tools=APP_TOOLS + BROWSER_TOOLS, setup=cross_app_setup, check=cross_app_check,
        cleanup=close_textedit, requires_absent=["TextEdit"]),
    # Multi-step.
    "calc-to-textedit": dict(
        prompt="Use Calculator to add 1234 and 5678, then write just the result into a new TextEdit document. Do not save it.",
        apps={"Calculator", "TextEdit"}, tools=APP_TOOLS, check=calc_to_textedit_check,
        cleanup=lambda: (quit_app("Calculator"), close_textedit()), requires_absent=["Calculator", "TextEdit"]),
    "textedit-bold": dict(
        prompt="In TextEdit, create a new rich-text document with two lines: \"Report\" in bold, then \"All good\" in regular weight. Do not save it.",
        apps={"TextEdit"}, tools=APP_TOOLS, check=bold_check, cleanup=close_textedit, requires_absent=["TextEdit"]),
    "preview-pdf": dict(
        prompt=f"Open {WORK}/files/brief.pdf in Preview and tell me the code word written on its second page.",
        apps={"Preview"}, tools=APP_TOOLS, setup=pdf_setup, check=pdf_check, cleanup=close_preview,
        requires_absent=["Preview"]),
}


# ---------------------------------------------------------------- watcher

class Watcher:
    """Samples the front app and the owner of the topmost normal window."""

    def __init__(self):
        self.proc = subprocess.Popen([str(helper_binary("watch"))], stdout=subprocess.PIPE, text=True)
        self.samples = []
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.proc.stdout:
            parts = line.rstrip("\n").split("\t")
            if len(parts) == 5:
                self.samples.append((float(parts[0]), parts[1], parts[2], float(parts[3]), set(filter(None, parts[4].split(",")))))

    def stop(self):
        self.proc.terminate()

    def saw_lock_screen(self, start, end):
        return any(start <= sample[0] <= end and sample[1] == "loginwindow" for sample in self.samples)

    def incidents(self, apps, start, end):
        """Times a watched app took the front or the top window while it had not
        been there at the start. The user's own switches show as recent input."""
        window = [sample for sample in self.samples if start <= sample[0] <= end]
        if not window:
            return {"samples": 0}
        _, first_front, first_top, _, first_overlays = window[0]
        found = {"samples": len(window), "front": [], "top_window": [], "overlay": []}
        for stamp, front, top, idle, overlays in window:
            if front in apps and first_front not in apps:
                found["front"].append({"t": round(stamp - start, 1), "app": front, "user_idle_s": idle})
            if top in apps and first_top not in apps:
                found["top_window"].append({"t": round(stamp - start, 1), "app": top, "user_idle_s": idle})
            for app in (overlays & apps) - first_overlays:
                found["overlay"].append({"t": round(stamp - start, 1), "app": app, "user_idle_s": idle})
        for key in ("front", "top_window", "overlay"):
            events = found[key]
            # Changes within a second of the user's own input are theirs.
            found[key + "_not_user"] = len([event for event in events if event["user_idle_s"] >= 1.0])
            found[key] = events[:5]
        return found


# ---------------------------------------------------------------- runner

def run_claude(prompt, tools, model, budget, timeout, out_path):
    config = json.dumps({"mcpServers": {"skfiy": {"command": BINARY, "args": ["mcp"]}}})
    allowed = [f"mcp__skfiy__{tool}" for tool in tools]
    denied = [f"mcp__skfiy__{tool}" for tool in APP_TOOLS + BROWSER_TOOLS if tool not in tools]
    command = ["claude", "-p", prompt, "--model", model, "--tools", "", "--mcp-config", config, "--strict-mcp-config",
               "--allowedTools", *allowed, "--output-format", "stream-json", "--verbose",
               "--max-budget-usd", str(budget), "--no-session-persistence"]
    if denied:
        command += ["--disallowedTools", *denied]
    started = time.time()
    with open(out_path, "w") as log:
        try:
            subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=timeout, cwd=WORK, stdin=subprocess.DEVNULL)
            timed_out = False
        except subprocess.TimeoutExpired:
            timed_out = True
    elapsed = time.time() - started
    calls, errors, answer, cost, turns, opened = [], 0, "", None, None, []
    for line in open(out_path):
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "assistant":
            for block in event["message"].get("content", []):
                if block.get("type") == "tool_use":
                    calls.append(block["name"].replace("mcp__skfiy__", ""))
        elif event.get("type") == "user":
            for block in event["message"].get("content", []):
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    errors += 1 if block.get("is_error") else 0
                    content = block.get("content")
                    text = content[0].get("text", "") if isinstance(content, list) and content else str(content)
                    opened += re.findall(r"in background tab (\d+)", text)
        elif event.get("type") == "result":
            answer = event.get("result") or ""
            cost = event.get("total_cost_usd")
            turns = event.get("num_turns")
    return {"seconds": round(elapsed, 1), "timed_out": timed_out, "tool_calls": len(calls), "tool_errors": errors,
            "tools_used": sorted(set(calls)), "turns": turns, "cost_usd": cost, "answer": answer.strip(), "opened_tabs": opened}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("tasks", nargs="*", default=list(TASKS))
    parser.add_argument("--model", default="sonnet")
    parser.add_argument("--budget", type=float, default=1.5, help="max USD per task")
    parser.add_argument("--timeout", type=int, default=480, help="seconds per task")
    parser.add_argument("--wait-unlock", type=int, default=3600, help="seconds to wait for a locked screen")
    options = parser.parse_args()

    os.makedirs(f"{WORK}/bin", exist_ok=True)
    if os.path.exists(BINARY):
        os.remove(BINARY)  # replace, never overwrite a signed binary in place
    shutil.copy(f"{ROOT}/.build/debug/skfiy", BINARY)
    results_dir = f"{ROOT}/eval/results/{datetime.datetime.now():%Y%m%d-%H%M%S}"
    os.makedirs(results_dir)

    watcher = Watcher()
    summary = []
    try:
        for name in options.tasks:
            task = TASKS[name]
            if not wait_until_unlocked(options.wait_unlock):
                print("screen stayed locked; stopping")
                break
            busy = [app for app in task.get("requires_absent", []) if running(app)]
            if busy:
                print(f"- {name}: skipped ({', '.join(busy)} is already running; it may hold your work)")
                continue
            if task.get("setup"):
                task["setup"]()
            start = time.time()
            run = run_claude(task["prompt"], task["tools"], options.model, options.budget, options.timeout,
                             f"{results_dir}/{name}.jsonl")
            end = time.time() + 0.5
            time.sleep(0.6)
            context = {"opened_tabs": run["opened_tabs"]}
            try:
                checks = task["check"](run["answer"], context)
            except Exception as error:  # noqa: BLE001 - reported as a failed check
                checks = {f"check raised {error!r}": False}
            incidents = watcher.incidents(task["apps"], start, end)
            locked = watcher.saw_lock_screen(start, end) or screen_locked()
            if task.get("cleanup") and not locked:
                task["cleanup"]()
            if locked:
                # Apps cannot be driven while locked; the run says nothing about skfiy.
                print(f"~ {name}: not counted (the screen was locked during the run)", flush=True)
                if task.get("cleanup"):
                    wait_until_unlocked(options.wait_unlock)
                    task["cleanup"]()
                continue
            ok = all(checks.values())
            kept_back = all(incidents.get(f"{key}_not_user", 0) == 0 for key in ("front", "top_window", "overlay"))
            record = {"task": name, "ok": ok, "stayed_in_background": kept_back, "checks": checks,
                      "incidents": incidents, **run}
            summary.append(record)
            with open(f"{results_dir}/{name}.json", "w") as handle:
                json.dump(record, handle, ensure_ascii=False, indent=1)
            cost = f"${run['cost_usd']:.2f}" if run["cost_usd"] is not None else "?"
            print(f"{'✔' if ok else '✘'} {name}: {run['seconds']}s, {run['tool_calls']} calls ({run['tool_errors']} errors), {cost}; "
                  f"background {'kept' if kept_back else 'BROKEN'}; " + "; ".join(f"{'✔' if v else '✘'} {k}" for k, v in checks.items()))
            print(f"    answer: {run['answer'][:200]!r}")
    finally:
        watcher.stop()
    with open(f"{results_dir}/summary.json", "w") as handle:
        json.dump(summary, handle, ensure_ascii=False, indent=1)
    passed = sum(record["ok"] for record in summary)
    background = sum(record["stayed_in_background"] for record in summary)
    print(f"{passed}/{len(summary)} tasks done; {background}/{len(summary)} stayed in the background → {results_dir}")


if __name__ == "__main__":
    main()
