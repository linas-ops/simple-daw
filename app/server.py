"""Simple DAW - local app server.

Double-click "Start Simple DAW.bat" one folder up to run this. It:
  * serves the app interface to a browser window (Edge/Chrome in app mode),
  * keeps songs in ../Projects and finished files in ../Exports,
  * hosts VST2/VST3 drum plugins through engine_worker.py in a separate process.

Everything listens on 127.0.0.1 only; nothing is reachable from other computers.
"""
from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import mimetypes
import multiprocessing as mp
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

APP_NAME = "Simple DAW"
APP_VERSION = "1.5.1"
HOST = "127.0.0.1"
DEFAULT_PORT = int(os.environ.get("SIMPLE_DAW_PORT", "47321"))
IS_WINDOWS = os.name == "nt"

APP_DIR = Path(__file__).resolve().parent
ROOT_DIR = APP_DIR.parent
WEB_DIR = APP_DIR / "web"
BUILTIN_KITS_DIR = APP_DIR / "kits"
DATA_DIR = APP_DIR / "data"
PROJECTS_DIR = ROOT_DIR / "Projects"
MEDIA_DIR = PROJECTS_DIR / "Media"
TRASH_DIR = PROJECTS_DIR / "Deleted songs"
EXPORTS_DIR = ROOT_DIR / "Exports"
USER_KITS_DIR = ROOT_DIR / "Kits"
SETTINGS_FILE = DATA_DIR / "settings.json"
LOG_FILE = DATA_DIR / "simple-daw.log"

for _d in (DATA_DIR, PROJECTS_DIR, MEDIA_DIR, EXPORTS_DIR, USER_KITS_DIR):
    _d.mkdir(parents=True, exist_ok=True)

# pythonw.exe has no console: send output to the log file instead.
_STDOUT_IS_LOG = False
if sys.stdout is None or sys.stderr is None:
    _log_stream = open(LOG_FILE, "a", encoding="utf-8", buffering=1)
    _STDOUT_IS_LOG = sys.stdout is None
    sys.stdout = sys.stdout or _log_stream
    sys.stderr = sys.stderr or _log_stream

_log_lock = threading.Lock()


def log(*parts) -> None:
    line = time.strftime("%Y-%m-%d %H:%M:%S ") + " ".join(str(p) for p in parts)
    with _log_lock:
        if not _STDOUT_IS_LOG:  # with pythonw, stdout already is the log file
            try:
                print(line, flush=True)
            except Exception:  # noqa: BLE001
                pass
        try:
            with open(LOG_FILE, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        except Exception:  # noqa: BLE001
            pass


def show_error_box(message: str) -> None:
    log("ERROR:", message)
    if IS_WINDOWS:
        try:
            import ctypes

            ctypes.windll.user32.MessageBoxW(0, message, APP_NAME, 0x10)
        except Exception:  # noqa: BLE001
            pass


# --------------------------------------------------------------------------
# Settings
# --------------------------------------------------------------------------
class Settings:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.Lock()
        self.data: dict = {}
        try:
            self.data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            self.data = {}

    def get(self, key, default=None):
        with self.lock:
            return self.data.get(key, default)

    def update(self, values: dict) -> dict:
        with self.lock:
            self.data.update(values)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.data, indent=2), encoding="utf-8")
            os.replace(tmp, self.path)
            return dict(self.data)

    def all(self) -> dict:
        with self.lock:
            return dict(self.data)


SETTINGS = Settings(SETTINGS_FILE)


# --------------------------------------------------------------------------
# Plugin discovery
# --------------------------------------------------------------------------
DRUM_WORDS = re.compile(
    r"drum|kit|ssd|slate|power|ezd|superior|addictive|bfd|getgood|ggd|sitala|"
    r"drummica|krimh|perfect|groove|beat|perc|snare|kick|trigger|ugritone|room sound",
    re.IGNORECASE,
)


def default_plugin_dirs() -> list[Path]:
    dirs: list[Path] = []
    if IS_WINDOWS:
        pf = Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
        cpf = Path(os.environ.get("CommonProgramFiles", r"C:\Program Files\Common Files"))
        dirs += [
            cpf / "VST3",
            cpf / "VST2",
            cpf / "Steinberg" / "VST2",
            pf / "VSTPlugins",
            pf / "Steinberg" / "VSTPlugins",
            pf / "Vstplugins",
            pf / "Common Files" / "VST3",
        ]
        try:
            import winreg

            for root in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
                for sub in (r"SOFTWARE\VST",):
                    try:
                        with winreg.OpenKey(root, sub) as key:
                            value, _ = winreg.QueryValueEx(key, "VSTPluginsPath")
                            if value:
                                dirs.append(Path(value))
                    except OSError:
                        pass
        except ImportError:
            pass
    else:
        home = Path.home()
        dirs += [home / ".vst3", Path("/usr/lib/vst3"), Path("/usr/local/lib/vst3"), home / ".vst", Path("/usr/lib/vst")]
    for extra in SETTINGS.get("pluginFolders", []) or []:
        dirs.append(Path(extra))
    seen, unique = set(), []
    for d in dirs:
        key = str(d).lower() if IS_WINDOWS else str(d)
        if key not in seen:
            seen.add(key)
            unique.append(d)
    return unique


def pe_machine(path: Path) -> str | None:
    """Return 'x64', 'x86', 'arm64' or None for a Windows DLL."""
    try:
        with open(path, "rb") as fh:
            head = fh.read(4096)
        if head[:2] != b"MZ":
            return None
        offset = int.from_bytes(head[0x3C:0x40], "little")
        if offset + 6 > len(head):
            with open(path, "rb") as fh:
                fh.seek(offset)
                head2 = fh.read(6)
            sig, mach = head2[:4], int.from_bytes(head2[4:6], "little")
        else:
            sig, mach = head[offset:offset + 4], int.from_bytes(head[offset + 4:offset + 6], "little")
        if sig != b"PE\0\0":
            return None
        return {0x8664: "x64", 0x14C: "x86", 0xAA64: "arm64"}.get(mach, "other")
    except Exception:  # noqa: BLE001
        return None


def describe_plugin(path: Path) -> dict | None:
    name = path.name
    lower = name.lower()
    fmt = None
    arch = None
    if lower.endswith(".vst3"):
        fmt = "VST3"
        if path.is_dir():
            contents = path / "Contents"
            if IS_WINDOWS:
                if (contents / "x86_64-win").exists():
                    arch = "x64"
                elif (contents / "x86-win").exists():
                    arch = "x86"
            elif (contents / "x86_64-linux").exists():
                arch = "x64"
        elif IS_WINDOWS:
            arch = pe_machine(path)
    elif IS_WINDOWS and lower.endswith(".dll"):
        fmt = "VST2"
        arch = pe_machine(path)
        if arch is None:
            return None
    elif not IS_WINDOWS and lower.endswith(".so"):
        fmt = "VST2"
        arch = "x64"
    else:
        return None
    stem = re.sub(r"\.(vst3|dll|so)$", "", name, flags=re.IGNORECASE)
    usable = arch in (None, "x64")
    return {
        "name": stem,
        "path": str(path),
        "format": fmt,
        "arch": arch or "unknown",
        "usable": usable,
        "drums": bool(DRUM_WORDS.search(stem)),
    }


def scan_plugins() -> list[dict]:
    found: dict[str, dict] = {}
    for base in default_plugin_dirs():
        if not base.exists():
            continue
        base_depth = len(base.parts)
        for root, dirnames, filenames in os.walk(base):
            root_path = Path(root)
            if len(root_path.parts) - base_depth > 4:
                dirnames[:] = []
                continue
            keep = []
            for d in dirnames:
                if d.lower().endswith(".vst3"):
                    info = describe_plugin(root_path / d)
                    if info:
                        found.setdefault(info["path"].lower(), info)
                else:
                    keep.append(d)
            dirnames[:] = keep
            for f in filenames:
                if f.lower().endswith((".vst3", ".dll", ".so")):
                    info = describe_plugin(root_path / f)
                    if info:
                        found.setdefault(info["path"].lower(), info)
    plugins = sorted(found.values(), key=lambda p: (not p["usable"], not p["drums"], p["name"].lower()))
    return plugins


def normalize_plugin_path(path: str) -> str:
    """If a file inside a .vst3 bundle was picked, return the bundle folder."""
    p = Path(path)
    for parent in [p] + list(p.parents):
        if parent.name.lower().endswith(".vst3") and parent.is_dir():
            return str(parent)
    return str(p)


# --------------------------------------------------------------------------
# Sample kits (SFZ)
# --------------------------------------------------------------------------
KIT_MANIFEST = "simple-daw-kit.json"

KIT_CATALOG = [
    {
        "id": "naked-drums",
        "name": "Naked Drums",
        "author": "Wilkinson Audio",
        "license": "CC BY 4.0",
        "size": "1.3 GB",
        "bytes": 1_290_000_000,
        "desc": "Yamaha Recording Custom with Sabian and Zildjian cymbals. 10 round robins, up to 5 velocity layers and several mics.",
        "repo": "sfzinstruments/WilkinsonAudio.NakedDrums",
        "branch": "master",
        "folder": "Naked Drums",
        "generate": [
            {
                "from": "Wilkinson Audio/Naked Drums/Stereo/Naked Drums.sfz",
                "to": "Wilkinson Audio/Naked Drums/User/Simple DAW Big Room.sfz",
                "replace": [['#include "../Data/keymap.txt"', '#include "Naked Drums GM keymap.txt"']],
                "drop": ["Splash2", "China2"],
            }
        ],
        "manifest": {
            "name": "Naked Drums",
            "author": "Wilkinson Audio",
            "license": "CC BY 4.0",
            "programs": [
                {"name": "Naked Drums (studio)", "file": "Wilkinson Audio/Naked Drums/User/Naked Drums GM.sfz",
                 "desc": "Close mics and overheads. Tight, punchy and quick to load."},
                {"name": "Naked Drums (big room)", "file": "Wilkinson Audio/Naked Drums/User/Simple DAW Big Room.sfz",
                 "desc": "Every mic, including the room. Bigger and more natural."},
            ],
            "noteMap": {"40": 38, "42": 54},
            "hihat": {"cc": 4, "rules": {"42": [[0, 40, 56], [41, 110, 54], [111, 127, 42]],
                                         "46": [[0, 35, 46], [36, 95, 56], [96, 127, 54]]}},
            # What these notes play in this kit (General MIDI names them differently).
            "labels": {"54": "Hi-hat closed 2", "56": "Hi-hat half-open", "58": "Crash bell", "59": "Crash 2 bell"},
        },
    },
    {
        "id": "muldjord",
        "name": "Muldjord Kit",
        "author": "DrumGizmo team (Lars Muldjord)",
        "license": "CC BY 4.0",
        "size": "350 MB",
        "bytes": 347_000_000,
        "desc": "Tama Superstar rock and metal kit with two kick drums, four toms and lots of hits per drum.",
        "repo": "sfzinstruments/DrumGizmo.MuldjordKit",
        "branch": "master",
        "folder": "Muldjord Kit",
        "manifest": {
            "name": "Muldjord Kit",
            "author": "DrumGizmo team (Lars Muldjord)",
            "license": "CC BY 4.0",
            "programs": [
                {"name": "Muldjord Kit", "file": "DrumGizmo/MuldjordKit/Stereo/DrumGizmo MuldjordKit.sfz",
                 "desc": "Tama Superstar, all mics. A rock and metal kit."},
            ],
            # Muldjord has no splash (its key 55 is a ride bell), so the splash plays a crash.
            "noteMap": {"43": 41, "40": 38, "50": 48, "55": 57},
        },
    },
    {
        "id": "drs",
        "name": "DRS Kit",
        "author": "DrumGizmo team and DRSDrums",
        "license": "CC BY 4.0",
        "size": "750 MB",
        "bytes": 754_000_000,
        "desc": "Handmade DRS kit with Paiste cymbals. Works for anything from jazz to rock.",
        "repo": "sfzinstruments/DrumGizmo.DRSKit",
        "branch": "master",
        "folder": "DRS Kit",
        "manifest": {
            "name": "DRS Kit",
            "author": "DrumGizmo team and DRSDrums",
            "license": "CC BY 4.0",
            "programs": [
                {"name": "DRS Kit", "file": "DrumGizmo/DRSKit/Stereo/DrumGizmo DRSKit (N).sfz",
                 "desc": "Handmade DRS kit with Paiste cymbals, all mics."},
            ],
            "noteMap": {"48": 47, "45": 43, "43": 41, "50": 47, "40": 37, "52": 57, "59": 51},
            "hihat": {"cc": 4, "rules": {"46": [[0, 40, 58], [41, 100, 46], [101, 127, 42]]}},
            "labels": {"54": "Crash tip", "56": "Hi-hat closed 2", "58": "Hi-hat open 2"},
        },
    },
]


KITDEFS_DIR = APP_DIR / "kitdefs"


def _load_kitdefs() -> list[dict]:
    """Kits Simple DAW puts together itself (like Percussion): a mapping that ships with
    the app plus a list of sample files to download."""
    out = []
    if KITDEFS_DIR.exists():
        for f in sorted(KITDEFS_DIR.glob("*/kit.json")):
            try:
                entry = json.loads(f.read_text(encoding="utf-8"))
                entry["_dir"] = str(f.parent)
                out.append(entry)
            except Exception as exc:  # noqa: BLE001
                print("Kit definition couldn't be read:", f, exc, file=sys.stderr)
    return out


KIT_CATALOG = _load_kitdefs() + KIT_CATALOG


def kits_available() -> bool:
    return importlib.util.find_spec("soundfile") is not None and importlib.util.find_spec("numpy") is not None


def _known_kit_manifest(kit_dir: Path) -> dict | None:
    """Note maps for well-known SFZ kits people unzip themselves (app/kitdefs/known)."""
    for f in sorted((KITDEFS_DIR / "known").glob("*.json")):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        if any((kit_dir / marker).exists() for marker in d.get("match", [])):
            return d.get("manifest")
    return None


def _kit_from_folder(kit_dir: Path) -> dict | None:
    manifest_path = kit_dir / KIT_MANIFEST
    m = None
    if manifest_path.exists():
        try:
            m = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            m = None
    else:
        m = _known_kit_manifest(kit_dir)
    if m:
        programs = []
        for prog in m.get("programs", []):
            path = kit_dir / prog.get("file", "")
            if path.exists():
                programs.append({"name": prog.get("name") or path.stem, "desc": prog.get("desc", ""), "path": str(path)})
        if programs:
            return {
                "id": str(kit_dir),
                "name": m.get("name") or kit_dir.name,
                "author": m.get("author", ""),
                "license": m.get("license", ""),
                "programs": programs,
                "noteMap": m.get("noteMap") or {},
                "hihat": m.get("hihat") or None,
                "role": m.get("role") or "drums",
                "labels": m.get("labels") or {},
                "sounds": m.get("sounds") or [],
                "calibrate": m.get("calibrate") or None,
                "cc": m.get("cc") or {},
            }
    programs = []
    base_depth = len(kit_dir.parts)
    for root, dirnames, filenames in os.walk(kit_dir):
        rp = Path(root)
        if len(rp.parts) - base_depth > 5:
            dirnames[:] = []
            continue
        # Folders of pieces that other .sfz files include are not kits of their own.
        dirnames[:] = [d for d in dirnames if not d.lower().startswith(("multi", "keymap", "mapping", "include", "."))]
        for f in filenames:
            if f.lower().endswith(".sfz"):
                p = rp / f
                rel = p.parent.relative_to(kit_dir)
                pretty = re.sub(r"[_]+", " ", p.stem).strip()
                programs.append({"name": pretty, "desc": kit_dir.name if str(rel) == "." else f"{kit_dir.name}, {rel}", "path": str(p)})
    if not programs:
        return None
    programs.sort(key=lambda x: (len(Path(x["path"]).parts), x["name"].lower()))
    return {"id": str(kit_dir), "name": kit_dir.name, "author": "", "license": "", "programs": programs[:24], "noteMap": {}, "hihat": None,
            "role": "drums", "labels": {}, "sounds": [], "calibrate": None, "cc": {}}


def scan_kits() -> list[dict]:
    kits = []
    seen = set()
    folders = []
    if USER_KITS_DIR.exists():
        folders += [d for d in sorted(USER_KITS_DIR.iterdir(), key=lambda x: x.name.lower())
                    if d.is_dir() and not d.name.startswith(("_", "."))]
    folders += [Path(extra) for extra in SETTINGS.get("kitFolders", []) or []]
    for d in folders:
        try:
            key = str(d.resolve()).lower()
        except OSError:
            continue
        if key in seen or not d.is_dir():
            continue  # the same folder added twice shows once
        seen.add(key)
        k = _kit_from_folder(d)
        if k:
            kits.append(k)
    return kits


class KitInstaller:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.jobs: dict[str, dict] = {}

    def status(self) -> dict:
        with self.lock:
            return {k: dict(v) for k, v in self.jobs.items()}

    def _set(self, kit_id: str, **values) -> None:
        with self.lock:
            self.jobs.setdefault(kit_id, {}).update(values)

    def start(self, kit_id: str) -> None:
        entry = next((c for c in KIT_CATALOG if c["id"] == kit_id), None)
        if entry is None:
            raise ValueError("Unknown kit.")
        with self.lock:
            job = self.jobs.get(kit_id)
            if job and job.get("state") in ("downloading", "extracting"):
                return
            self.jobs[kit_id] = {"state": "downloading", "bytes": 0, "total": entry["bytes"], "error": None}
        threading.Thread(target=self._run, args=(entry,), daemon=True).start()

    def _run(self, entry: dict) -> None:
        if (entry.get("source") or {}).get("type") == "files":
            self._run_files(entry)
            return
        kit_id = entry["id"]
        downloads = USER_KITS_DIR / "_downloads"
        downloads.mkdir(parents=True, exist_ok=True)
        zip_path = downloads / f"{kit_id}.zip"
        part = zip_path.with_suffix(".part")
        target = USER_KITS_DIR / entry["folder"]
        try:
            free = shutil.disk_usage(USER_KITS_DIR).free
            if free < entry["bytes"] * 2.3:
                raise RuntimeError(f"Not enough free disk space. {entry['name']} needs about {entry['bytes'] * 2.3 / 1e9:.1f} GB while installing.")
            url = f"https://codeload.github.com/{entry['repo']}/zip/refs/heads/{entry['branch']}"
            log("Downloading kit", entry["name"], url)
            req = urllib.request.Request(url, headers={"User-Agent": "SimpleDAW/" + APP_VERSION})
            with urllib.request.urlopen(req, timeout=60) as resp, open(part, "wb") as fh:
                done = 0
                while True:
                    chunk = resp.read(1 << 20)
                    if not chunk:
                        break
                    fh.write(chunk)
                    done += len(chunk)
                    self._set(kit_id, bytes=done)
            os.replace(part, zip_path)
            self._set(kit_id, state="extracting")
            import zipfile

            tmp = USER_KITS_DIR / f"_{entry['folder']}.partial"
            if tmp.exists():
                shutil.rmtree(tmp, ignore_errors=True)
            tmp.mkdir(parents=True)
            with zipfile.ZipFile(zip_path) as z:
                names = z.namelist()
                total = len(names)
                for i, name in enumerate(names):
                    parts = name.split("/", 1)
                    if len(parts) < 2 or not parts[1]:
                        continue
                    dest = (tmp / parts[1]).resolve()
                    if not within(tmp, dest):
                        continue
                    if name.endswith("/"):
                        dest.mkdir(parents=True, exist_ok=True)
                        continue
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    with z.open(name) as src, open(dest, "wb") as out:
                        shutil.copyfileobj(src, out, 1 << 20)
                    if i % 50 == 0:
                        self._set(kit_id, extracted=i, files=total)
            for gen in entry.get("generate", []):
                src = tmp / gen["from"]
                if src.exists():
                    text = src.read_text(encoding="utf-8", errors="replace")
                    lines = [ln for ln in text.splitlines() if not any(d in ln for d in gen.get("drop", []))]
                    text = "\n".join(lines)
                    for a, b in gen.get("replace", []):
                        text = text.replace(a, b)
                    (tmp / gen["to"]).write_text(text, encoding="utf-8")
            (tmp / KIT_MANIFEST).write_text(json.dumps(entry["manifest"], indent=2), encoding="utf-8")
            if target.exists():
                shutil.rmtree(target, ignore_errors=True)
            os.replace(tmp, target)
            try:
                zip_path.unlink()
            except OSError:
                pass
            self._set(kit_id, state="done")
            log("Installed kit", entry["name"], "in", target)
        except Exception as exc:  # noqa: BLE001
            log("Kit install failed", entry["name"], traceback.format_exc())
            self._set(kit_id, state="error", error=str(exc))

    def _run_files(self, entry: dict) -> None:
        """Download a list of sample files (for kits Simple DAW maps itself, like Percussion).

        Files already downloaded are kept, so "Try again" picks up where it stopped."""
        from concurrent.futures import ThreadPoolExecutor

        kit_id = entry["id"]
        src = entry["source"]
        target = USER_KITS_DIR / entry["folder"]
        tmp = USER_KITS_DIR / f"_{entry['folder']}.partial"
        try:
            USER_KITS_DIR.mkdir(parents=True, exist_ok=True)
            files = [(str(p), int(size)) for p, size in src["files"]]
            total = sum(size for _, size in files)
            if shutil.disk_usage(USER_KITS_DIR).free < total * 1.3:
                raise RuntimeError(f"Not enough free disk space. {entry['name']} needs about {total * 1.3 / 1e6:.0f} MB.")
            if target.exists() and not tmp.exists():
                os.replace(target, tmp)  # update an existing install in place
            into = tmp / src.get("into", "")
            log("Downloading kit", entry["name"], f"({len(files)} files)")
            lock = threading.Lock()
            done = [0]

            def fetch(item):
                rel, size = item
                dest = (into / rel).resolve()
                if not within(tmp, dest):
                    raise RuntimeError(f"Unsafe file name in the kit list: {rel}")
                if dest.exists() and dest.stat().st_size == size:
                    got = size
                else:
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    part = dest.with_name(dest.name + ".part")
                    url = src["base"] + quote(rel)
                    req = urllib.request.Request(url, headers={"User-Agent": "SimpleDAW/" + APP_VERSION})
                    with urllib.request.urlopen(req, timeout=60) as resp, open(part, "wb") as fh:
                        got = 0
                        while True:
                            chunk = resp.read(1 << 16)
                            if not chunk:
                                break
                            fh.write(chunk)
                            got += len(chunk)
                    if size and got != size:
                        raise RuntimeError(f"A file didn't download completely: {rel}")
                    os.replace(part, dest)
                with lock:
                    done[0] += got
                    self._set(kit_id, bytes=done[0])

            with ThreadPoolExecutor(max_workers=6) as pool:
                for _ in pool.map(fetch, files):
                    pass
            kitdef_dir = Path(entry["_dir"])
            for name in src.get("copy", []):
                shutil.copyfile(kitdef_dir / name, tmp / name)
            (tmp / KIT_MANIFEST).write_text(json.dumps(entry["manifest"], indent=2, ensure_ascii=False), encoding="utf-8")
            if target.exists():
                shutil.rmtree(target, ignore_errors=True)
            os.replace(tmp, target)
            self._set(kit_id, state="done", bytes=total)
            log("Installed kit", entry["name"], "in", target)
        except Exception as exc:  # noqa: BLE001
            log("Kit install failed", entry["name"], traceback.format_exc())
            self._set(kit_id, state="error", error=str(exc))


KIT_INSTALLER = KitInstaller()


def refresh_kitdef_installs() -> None:
    """Keep installed kits up to date with the note maps and mappings that ship with the app."""
    for entry in KIT_CATALOG:
        target = USER_KITS_DIR / entry["folder"]
        if not (target / KIT_MANIFEST).exists():
            continue
        try:
            if (entry.get("source") or {}).get("type") == "files":
                for name in entry["source"].get("copy", []):
                    fresh = (Path(entry["_dir"]) / name).read_bytes()
                    dest = target / name
                    if not dest.exists() or dest.read_bytes() != fresh:
                        dest.write_bytes(fresh)
            manifest = json.dumps(entry["manifest"], indent=2, ensure_ascii=False)
            mpath = target / KIT_MANIFEST
            if mpath.read_text(encoding="utf-8") != manifest:
                tmp = mpath.with_suffix(".tmp")
                tmp.write_text(manifest, encoding="utf-8")
                os.replace(tmp, mpath)
        except Exception as exc:  # noqa: BLE001
            log("Couldn't refresh kit", entry["name"], exc)


def catalog_with_status() -> list[dict]:
    jobs = KIT_INSTALLER.status()
    out = []
    for c in KIT_CATALOG:
        item = {k: c[k] for k in ("id", "name", "author", "license", "size", "desc")}
        item["installed"] = (USER_KITS_DIR / c["folder"] / KIT_MANIFEST).exists()
        item["job"] = jobs.get(c["id"])
        out.append(item)
    return out


# --------------------------------------------------------------------------
# Native file dialogs (run as a separate PowerShell process on Windows)
# --------------------------------------------------------------------------
def _powershell(script: str, timeout: int = 600) -> str:
    flags = 0x08000000 if IS_WINDOWS else 0  # CREATE_NO_WINDOW
    result = subprocess.run(
        ["powershell", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script],
        capture_output=True,
        text=True,
        timeout=timeout,
        creationflags=flags,
    )
    return (result.stdout or "").strip()


def pick_file(title: str, filter_text: str, initial_dir: str | None = None) -> str | None:
    if IS_WINDOWS:
        init = (initial_dir or "").replace("'", "''")
        script = (
            "Add-Type -AssemblyName System.Windows.Forms;"
            "$owner = New-Object System.Windows.Forms.Form -Property @{TopMost=$true; ShowInTaskbar=$false};"
            "$d = New-Object System.Windows.Forms.OpenFileDialog;"
            f"$d.Title = '{title}'; $d.Filter = '{filter_text}';"
            f"if ('{init}' -ne '') {{ $d.InitialDirectory = '{init}' }};"
            "if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.FileName) }"
        )
        out = _powershell(script)
        return out or None
    if shutil.which("zenity"):
        r = subprocess.run(["zenity", "--file-selection", f"--title={title}"], capture_output=True, text=True)
        return r.stdout.strip() or None
    raise RuntimeError("File dialogs are only available on Windows.")


def pick_folder(title: str) -> str | None:
    if IS_WINDOWS:
        script = (
            "Add-Type -AssemblyName System.Windows.Forms;"
            "$owner = New-Object System.Windows.Forms.Form -Property @{TopMost=$true; ShowInTaskbar=$false};"
            "$d = New-Object System.Windows.Forms.FolderBrowserDialog;"
            f"$d.Description = '{title}';"
            "if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }"
        )
        out = _powershell(script)
        return out or None
    if shutil.which("zenity"):
        r = subprocess.run(["zenity", "--file-selection", "--directory", f"--title={title}"], capture_output=True, text=True)
        return r.stdout.strip() or None
    raise RuntimeError("Folder dialogs are only available on Windows.")


def reveal_in_explorer(path: Path) -> None:
    if IS_WINDOWS:
        if path.is_file():
            subprocess.Popen(["explorer", "/select,", str(path)])
        else:
            subprocess.Popen(["explorer", str(path)])
    elif shutil.which("xdg-open"):
        subprocess.Popen(["xdg-open", str(path if path.is_dir() else path.parent)])


# --------------------------------------------------------------------------
# Plugin engine process
# --------------------------------------------------------------------------
class EngineError(Exception):
    pass


class EngineClient:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.proc = None
        self.conn = None
        self.loaded: dict | None = None
        self.busy_with = None

    @staticmethod
    def available() -> bool:
        return importlib.util.find_spec("dawdreamer") is not None and importlib.util.find_spec("numpy") is not None

    def _start(self) -> None:
        import engine_worker  # noqa: F401  (makes sure the module imports cleanly)

        ctx = mp.get_context("spawn")
        parent, child = ctx.Pipe()
        proc = ctx.Process(target=engine_worker.worker_main, args=(child,), daemon=True, name="simple-daw-engine")
        proc.start()
        child.close()
        self.proc, self.conn = proc, parent
        log("Plugin engine started, pid", proc.pid)

    def _alive(self) -> bool:
        return self.proc is not None and self.proc.is_alive()

    def _kill(self) -> None:
        try:
            if self.proc is not None and self.proc.is_alive():
                self.proc.kill()
        except Exception:  # noqa: BLE001
            pass
        self.proc, self.conn, self.loaded = None, None, None

    def call(self, msg: dict, timeout: float | None = 120.0) -> dict:
        with self.lock:
            if not self._alive():
                self._kill()
                self._start()
            self.busy_with = msg.get("cmd")
            try:
                self.conn.send(msg)
                if timeout is None:
                    reply = self.conn.recv()
                else:
                    if not self.conn.poll(timeout):
                        self._kill()
                        raise EngineError("The plugin took too long to respond, so it was closed. Try loading it again.")
                    reply = self.conn.recv()
            except (EOFError, OSError, BrokenPipeError) as exc:
                self._kill()
                raise EngineError("The plugin crashed and was closed. Load it again to keep going.") from exc
            finally:
                self.busy_with = None
        if not reply.get("ok"):
            if reply.get("trace"):
                log("Engine error:", reply.get("trace"))
            raise EngineError(reply.get("error") or "The plugin engine reported an error.")
        return reply

    def stop(self) -> None:
        if self._alive():
            try:
                with self.lock:
                    self.conn.send({"cmd": "quit"})
                    self.conn.poll(2)
            except Exception:  # noqa: BLE001
                pass
        self._kill()


ENGINE = EngineClient()


# --------------------------------------------------------------------------
# Projects & files
# --------------------------------------------------------------------------
SAFE_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]+')


def safe_filename(name: str, default: str = "Untitled") -> str:
    name = SAFE_NAME.sub(" ", (name or "").strip()).strip(" .")
    return (name or default)[:80]


def unique_path(folder: Path, stem: str, ext: str) -> Path:
    candidate = folder / f"{stem}{ext}"
    n = 2
    while candidate.exists():
        candidate = folder / f"{stem} ({n}){ext}"
        n += 1
    return candidate


def project_summary(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None
    takes = data.get("takes") or []
    active = next((t for t in takes if t.get("id") == data.get("activeTake")), takes[0] if takes else None)
    notes = (active or {}).get("notes") or []
    length = max((n[0] if isinstance(n, list) else n.get("t", 0)) for n in notes) if notes else 0
    return {
        "file": path.name,
        "name": data.get("name") or path.stem,
        "modified": path.stat().st_mtime,
        "hits": len(notes),
        "length": length,
        "takes": len(takes),
        "tempo": data.get("tempo"),
    }


def within(base: Path, target: Path) -> bool:
    try:
        target.resolve().relative_to(base.resolve())
        return True
    except ValueError:
        return False


# --------------------------------------------------------------------------
# App lifecycle (shut down when the window closes)
# --------------------------------------------------------------------------
class Lifecycle:
    def __init__(self) -> None:
        self.shutdown_event = threading.Event()
        self.last_seen = time.time()
        self.bye_at: float | None = None
        self.browser = None
        self.browser_started = 0.0
        self.lock = threading.Lock()

    def seen(self) -> None:
        with self.lock:
            self.last_seen = time.time()
            self.bye_at = None

    def bye(self, delay: float = 8.0) -> None:
        with self.lock:
            self.bye_at = time.time() + delay

    def tick(self) -> None:
        now = time.time()
        with self.lock:
            if self.bye_at and now >= self.bye_at and now - self.last_seen >= 4:
                log("App window closed; shutting down.")
                self.shutdown_event.set()
            if now - self.last_seen > 15 * 60 and ENGINE.busy_with != "editor":
                log("No app window for 15 minutes; shutting down.")
                self.shutdown_event.set()
        if self.browser is not None and self.browser.poll() is not None:
            ran = now - self.browser_started
            self.browser = None
            if ran > 5:
                self.bye(3.0)


LIFE = Lifecycle()


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("audio/flac", ".flac")
mimetypes.add_type("application/json", ".json")


class Handler(BaseHTTPRequestHandler):
    server_version = "SimpleDAW/" + APP_VERSION

    def log_message(self, fmt, *args):  # quiet
        return

    # -- helpers ------------------------------------------------------------
    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in ("127.0.0.1", "localhost")

    def _send(self, status: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _json(self, data, status: int = 200) -> None:
        self._send(status, json.dumps(data).encode("utf-8"), "application/json; charset=utf-8")

    def _error(self, message: str, status: int = 400) -> None:
        self._json({"ok": False, "error": message}, status)

    def _body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def _json_body(self) -> dict:
        raw = self._body()
        return json.loads(raw.decode("utf-8")) if raw else {}

    def _serve_file(self, path: Path) -> None:
        if not path.is_file():
            self._error("Not found", 404)
            return
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        self._send(200, path.read_bytes(), ctype)

    # -- routing --------------------------------------------------------------
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self._host_ok():
            self._error("Forbidden", 403)
            return
        url = urlparse(self.path)
        path = unquote(url.path)
        query = parse_qs(url.query)
        try:
            if path.startswith("/api/"):
                self._api_get(path, query)
            elif path.startswith("/kits/"):
                target = (BUILTIN_KITS_DIR / path[len("/kits/"):]).resolve()
                if within(BUILTIN_KITS_DIR, target):
                    self._serve_file(target)
                else:
                    self._error("Not found", 404)
            elif path.startswith("/media/"):
                target = (MEDIA_DIR / path[len("/media/"):]).resolve()
                if within(MEDIA_DIR, target):
                    self._serve_file(target)
                else:
                    self._error("Not found", 404)
            else:
                rel = path.lstrip("/") or "index.html"
                target = (WEB_DIR / rel).resolve()
                if within(WEB_DIR, target):
                    self._serve_file(target)
                else:
                    self._error("Not found", 404)
        except Exception as exc:  # noqa: BLE001
            log("GET failed", path, traceback.format_exc())
            self._error(str(exc), 500)

    def do_POST(self):
        if not self._host_ok():
            self._error("Forbidden", 403)
            return
        url = urlparse(self.path)
        path = unquote(url.path)
        query = parse_qs(url.query)
        try:
            self._api_post(path, query)
        except EngineError as exc:
            self._error(str(exc), 409)
        except Exception as exc:  # noqa: BLE001
            log("POST failed", path, traceback.format_exc())
            self._error(str(exc), 500)

    # -- GET api --------------------------------------------------------------
    def _api_get(self, path: str, query: dict) -> None:
        if path == "/api/hello":
            LIFE.seen()
            self._json({
                "ok": True,
                "app": "simple-daw",
                "version": APP_VERSION,
                "engine": ENGINE.available(),
                "kitsEngine": kits_available(),
                "platform": sys.platform,
                "python": sys.version.split()[0],
                "folders": {"projects": str(PROJECTS_DIR), "exports": str(EXPORTS_DIR)},
                "settings": SETTINGS.all(),
            })
        elif path == "/api/heartbeat":
            LIFE.seen()
            self._json({"ok": True})
        elif path == "/api/plugins":
            self._json({"ok": True, "plugins": scan_plugins(), "folders": [str(d) for d in default_plugin_dirs()]})
        elif path == "/api/kits":
            self._json({"ok": True, "kits": scan_kits(), "catalog": catalog_with_status(), "folder": str(USER_KITS_DIR), "available": kits_available()})
        elif path == "/api/kits/status":
            self._json({"ok": True, "catalog": catalog_with_status()})
        elif path == "/api/projects":
            items = [s for s in (project_summary(p) for p in PROJECTS_DIR.glob("*.sdaw")) if s]
            items.sort(key=lambda s: s["modified"], reverse=True)
            self._json({"ok": True, "projects": items})
        elif path == "/api/projects/load":
            name = (query.get("file") or [""])[0]
            target = (PROJECTS_DIR / name).resolve()
            if not name.endswith(".sdaw") or not within(PROJECTS_DIR, target) or not target.exists():
                self._error("That song file was not found.", 404)
                return
            data = json.loads(target.read_text(encoding="utf-8"))
            SETTINGS.update({"lastProject": name})
            self._json({"ok": True, "file": name, "project": data})
        elif path == "/api/settings":
            self._json({"ok": True, "settings": SETTINGS.all()})
        else:
            self._error("Unknown request", 404)

    # -- POST api -------------------------------------------------------------
    def _api_post(self, path: str, query: dict) -> None:
        if path == "/api/bye":
            self._body()
            LIFE.bye()
            self._json({"ok": True})
        elif path == "/api/quit":
            self._json({"ok": True})
            LIFE.shutdown_event.set()
        elif path == "/api/settings":
            data = self._json_body()
            self._json({"ok": True, "settings": SETTINGS.update(data)})
        elif path == "/api/plugins/browse":
            picked = pick_file(
                "Choose a drum plugin",
                "Plugins (*.vst3;*.dll)|*.vst3;*.dll|All files (*.*)|*.*",
                str(Path(os.environ.get("CommonProgramFiles", r"C:\Program Files\Common Files")) / "VST3") if IS_WINDOWS else None,
            )
            if not picked:
                self._json({"ok": True, "path": None})
                return
            picked = normalize_plugin_path(picked)
            info = describe_plugin(Path(picked)) or {"name": Path(picked).stem, "path": picked, "format": "VST", "usable": True, "drums": True, "arch": "unknown"}
            self._json({"ok": True, "path": picked, "plugin": info})
        elif path == "/api/plugins/add-folder":
            folder = pick_folder("Choose a folder that contains plugins")
            if folder:
                folders = list(SETTINGS.get("pluginFolders", []) or [])
                if folder not in folders:
                    folders.append(folder)
                SETTINGS.update({"pluginFolders": folders})
            self._json({"ok": True, "folder": folder, "plugins": scan_plugins()})
        elif path == "/api/engine/load":
            if not ENGINE.available():
                raise EngineError("The plugin engine isn't installed. Run 'Start Simple DAW.bat' again to finish setup.")
            data = self._json_body()
            reply = ENGINE.call({"cmd": "load", "path": data["path"], "sampleRate": int(data.get("sampleRate") or 48000), "state": data.get("state")}, timeout=240)
            reply.pop("ok", None)
            if not data.get("state"):
                try:
                    reply["state"] = ENGINE.call({"cmd": "get_state"}, timeout=60).get("state")
                except EngineError:
                    reply["state"] = None
            ENGINE.loaded = {"path": data["path"]}
            log("Loaded plugin", data["path"])
            self._json({"ok": True, **reply})
        elif path == "/api/engine/load-kit":
            if not kits_available():
                raise EngineError("The kit player isn't installed. Close Simple DAW and run 'Start Simple DAW.bat' again to finish setup.")
            data = self._json_body()
            reply = ENGINE.call({"cmd": "load_kit", "path": data["path"], "sampleRate": int(data.get("sampleRate") or 48000), "options": data.get("options") or {}}, timeout=240)
            reply.pop("ok", None)
            log("Loaded kit", data["path"])
            self._json({"ok": True, **reply})
        elif path == "/api/engine/takes":
            if not kits_available():
                raise EngineError("The kit player isn't installed.")
            data = self._json_body()
            reply = ENGINE.call({"cmd": "takes", "path": data["path"], "options": data.get("options"),
                                 "note": int(data["note"]), "raw": bool(data.get("raw"))}, timeout=240)
            reply.pop("ok", None)
            self._json({"ok": True, **reply})
        elif path == "/api/engine/describe-kit":
            if not kits_available():
                raise EngineError("The kit player isn't installed. Close Simple DAW and run 'Start Simple DAW.bat' again to finish setup.")
            data = self._json_body()
            reply = ENGINE.call({
                "cmd": "describe_kit",
                "path": data["path"],
                "sampleRate": int(data.get("sampleRate") or 48000),
                "options": data.get("options"),
                "preload": data.get("preload"),
            }, timeout=240)
            reply.pop("ok", None)
            self._json({"ok": True, **reply})
        elif path == "/api/kits/install":
            data = self._json_body()
            KIT_INSTALLER.start(data.get("id", ""))
            self._json({"ok": True, "catalog": catalog_with_status()})
        elif path == "/api/kits/add-folder":
            folder = pick_folder("Choose the folder of an SFZ drum kit")
            if folder:
                folders = list(SETTINGS.get("kitFolders", []) or [])
                if folder not in folders:
                    folders.append(folder)
                SETTINGS.update({"kitFolders": folders})
            self._json({"ok": True, "folder": folder, "kits": scan_kits()})
        elif path == "/api/engine/editor":
            reply = ENGINE.call({"cmd": "editor"}, timeout=None)
            self._json({"ok": True, "state": reply.get("state")})
        elif path == "/api/engine/state":
            data = self._json_body()
            ENGINE.call({"cmd": "set_state", "state": data["state"]}, timeout=120)
            self._json({"ok": True})
        elif path == "/api/engine/unload":
            if ENGINE._alive():
                ENGINE.call({"cmd": "unload"}, timeout=30)
            self._json({"ok": True})
        elif path == "/api/engine/render":
            data = self._json_body()
            reply = ENGINE.call({
                "cmd": "render",
                "notes": data.get("notes", []),
                "ccs": data.get("ccs", []),
                "start": data.get("start", 0.0),
                "preroll": data.get("preroll", 0.0),
                "length": data["length"],
                "sampleRate": int(data.get("sampleRate") or 48000),
                "cc": data.get("cc") or None,
                "routes": data.get("routes") or None,
                "variations": "random" if data.get("variations") == "random" else "cycle",
                "wash": data.get("wash", True) is not False,
                "blend": data.get("blend") if isinstance(data.get("blend"), dict) else None,
                "pedalStop": data.get("pedalStop", True) is not False,
            }, timeout=600)
            self._send(200, reply["pcm"], "application/octet-stream", {
                "X-Frames": str(reply["frames"]),
                "X-Channels": str(reply["channels"]),
                "X-Sample-Rate": str(reply["sampleRate"]),
                "X-Render-Ms": str(reply.get("ms", 0)),
            })
        elif path == "/api/projects/save":
            data = self._json_body()
            project = data["project"]
            file = data.get("file")
            if file:
                target = (PROJECTS_DIR / file).resolve()
                if not file.endswith(".sdaw") or not within(PROJECTS_DIR, target):
                    self._error("Invalid song file name.")
                    return
            else:
                target = unique_path(PROJECTS_DIR, safe_filename(project.get("name"), "Untitled song"), ".sdaw")
            tmp = target.with_suffix(".tmp")
            tmp.write_text(json.dumps(project, separators=(",", ":")), encoding="utf-8")
            os.replace(tmp, target)
            SETTINGS.update({"lastProject": target.name})
            self._json({"ok": True, "file": target.name})
        elif path == "/api/projects/delete":
            data = self._json_body()
            target = (PROJECTS_DIR / data.get("file", "")).resolve()
            if target.suffix == ".sdaw" and within(PROJECTS_DIR, target) and target.exists():
                TRASH_DIR.mkdir(parents=True, exist_ok=True)
                shutil.move(str(target), str(unique_path(TRASH_DIR, target.stem, ".sdaw")))
            self._json({"ok": True})
        elif path == "/api/media":
            name = safe_filename((query.get("name") or ["audio"])[0], "audio")
            body = self._body()
            digest = hashlib.sha1(body).hexdigest()[:12]
            target = MEDIA_DIR / f"{digest}-{name}"
            if not target.exists():
                target.write_bytes(body)
            self._json({"ok": True, "id": target.name})
        elif path == "/api/export":
            name = safe_filename((query.get("name") or ["Export"])[0], "Export")
            ext = (query.get("ext") or ["wav"])[0].lower()
            if ext not in ("wav", "mid"):
                self._error("Unsupported export type.")
                return
            target = unique_path(EXPORTS_DIR, name, "." + ext)
            target.write_bytes(self._body())
            log("Exported", target)
            self._json({"ok": True, "path": str(target), "file": target.name})
        elif path == "/api/reveal":
            data = self._json_body()
            target = Path(data.get("path", ""))
            if within(ROOT_DIR, target) and target.exists():
                reveal_in_explorer(target)
            self._json({"ok": True})
        elif path == "/api/open-folder":
            data = self._json_body()
            folder = {"exports": EXPORTS_DIR, "projects": PROJECTS_DIR, "kits": USER_KITS_DIR}.get(data.get("which"), ROOT_DIR)
            reveal_in_explorer(folder)
            self._json({"ok": True})
        else:
            self._error("Unknown request", 404)


# --------------------------------------------------------------------------
# Browser window
# --------------------------------------------------------------------------
def find_browser() -> str | None:
    if IS_WINDOWS:
        candidates = []
        for env in ("ProgramFiles(x86)", "ProgramFiles", "LocalAppData"):
            base = os.environ.get(env)
            if base:
                candidates += [
                    Path(base) / "Microsoft" / "Edge" / "Application" / "msedge.exe",
                    Path(base) / "Google" / "Chrome" / "Application" / "chrome.exe",
                ]
        for c in candidates:
            if c.exists():
                return str(c)
        return None
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"):
        found = shutil.which(name)
        if found:
            return found
    return None


def open_app_window(url: str):
    exe = find_browser()
    if exe:
        profile = DATA_DIR / "browser-profile"
        args = [
            exe,
            f"--app={url}",
            f"--user-data-dir={profile}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-features=Translate,msUndersideButton,msEdgeSidebarV2",
            "--autoplay-policy=no-user-gesture-required",
            "--window-size=1440,900",
        ]
        try:
            proc = subprocess.Popen(args)
            LIFE.browser = proc
            LIFE.browser_started = time.time()
            return
        except OSError as exc:
            log("Could not start browser:", exc)
    import webbrowser

    webbrowser.open(url)


def existing_instance(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://{HOST}:{port}/api/hello", timeout=2) as resp:
            return json.loads(resp.read().decode("utf-8")).get("app") == "simple-daw"
    except Exception:  # noqa: BLE001
        return False


def port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if not IS_WINDOWS:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((HOST, port))
            return True
        except OSError:
            return False


def main() -> int:
    no_browser = "--no-browser" in sys.argv
    port = DEFAULT_PORT
    if not port_free(port):
        if existing_instance(port):
            log("Simple DAW is already running; opening a window.")
            if not no_browser:
                open_app_window(f"http://{HOST}:{port}/")
            return 0
        for p in range(DEFAULT_PORT + 1, DEFAULT_PORT + 20):
            if port_free(p):
                port = p
                break
        else:
            show_error_box("Simple DAW couldn't find a free network port on this computer.")
            return 1

    server = ThreadingHTTPServer((HOST, port), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://{HOST}:{port}/"
    log(f"{APP_NAME} {APP_VERSION} running at {url} (Python {sys.version.split()[0]}, engine {'ready' if ENGINE.available() else 'missing'})")
    threading.Thread(target=refresh_kitdef_installs, daemon=True).start()
    if not no_browser:
        open_app_window(url)
    try:
        while not LIFE.shutdown_event.wait(0.5):
            LIFE.tick()
    except KeyboardInterrupt:
        pass
    log("Stopping.")
    if LIFE.browser is not None and LIFE.browser.poll() is None:
        try:
            LIFE.browser.terminate()
        except Exception:  # noqa: BLE001
            pass
    ENGINE.stop()
    server.shutdown()
    return 0


if __name__ == "__main__":
    mp.freeze_support()
    sys.path.insert(0, str(APP_DIR))
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001
        show_error_box("Simple DAW stopped because of an error:\n\n" + traceback.format_exc()[-1500:])
        sys.exit(1)
