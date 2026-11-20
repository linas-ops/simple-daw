"""SFZ drum-kit player for Simple DAW.

Reads SFZ instruments (including the ARIA-style ones with #define, #include,
mic-level controls, round robins and CC hi-hats) and renders drum hits to
stereo audio. Samples stream from disk on demand and are kept in a memory
cache, so multi-gigabyte kits work without loading everything up front.

Supported: <control> <global> <master> <group> <region> <curve>, #define,
#include, default_path, set_cc/set_hdcc/label_cc, key/lokey/hikey (numbers or
note names), lovel/hivel, locc/hicc (+ hdcc), lorand/hirand,
seq_length/seq_position, sw_lokey/sw_hikey/sw_last/sw_default, trigger,
group/off_by/off_mode/off_time/ampeg_release, polyphony/note_polyphony,
volume/amplitude at every level, amplitude_oncc/volume_oncc/gain_oncc/pan_oncc
with curves, amp_veltrack, amp_velcurve_N, xfin/xfout velocity crossfades,
pan, offset, end, delay, tune/transpose/pitch_keycenter/pitch_keytrack,
pitch_random/amp_random, note_offset/octave_offset, "*silence" regions.

All kits share one sample cache, so several kits can be used at once (a tom
from one kit, percussion from another) within the same memory budget.
"""
from __future__ import annotations

import math
import os
import random
import re
import threading
from collections import OrderedDict

import numpy as np

NOTE_NAMES = {"c": 0, "d": 2, "e": 4, "f": 5, "g": 7, "a": 9, "b": 11}
HEADER_RE = re.compile(r"<(\w+)>")
OPCODE_RE = re.compile(r"(?:(?<=\s)|(?<=>)|^)([A-Za-z_][A-Za-z0-9_]*)=", re.M)
DIRECTIVE_RE = re.compile(r"#(define|include)\b")
FAST_RELEASE = 0.006
# A hit on an open hi-hat or a crash that is still ringing blends into it (see render's
# blend). For each kind: how soon the next hit must come (s); how the last ring fades
# under it (base + per second of gap, within limits, s, at blend 0.8); how soft the new
# attack starts at full blend (floor) and over how long it reaches full level (span, s);
# and the gap below which the new attack is softest (near, s). A crash is tracked per key,
# the hi-hat as one instrument.
BLEND_KINDS = {
    "hat": {"max_gap": 0.75, "release": (0.4, 3.0, 0.5, 1.5), "floor": 0.1, "span": 0.11, "near": 0.18},
    "cym": {"max_gap": 1.6, "release": (0.8, 2.5, 1.0, 3.5), "floor": 0.25, "span": 0.13, "near": 0.25},
}
# How fast a grabbed (choked) cymbal goes quiet.
CHOKE_FADE = 0.15


class SfzError(Exception):
    pass


def parse_key(value) -> int | None:
    if value is None:
        return None
    s = str(value).strip().lower()
    if not s:
        return None
    try:
        return int(float(s))
    except ValueError:
        pass
    m = re.fullmatch(r"([a-g])(#|b|♯|♭)?(-?\d+)", s)
    if not m:
        return None
    n = NOTE_NAMES[m.group(1)]
    if m.group(2) in ("#", "♯"):
        n += 1
    elif m.group(2) in ("b", "♭"):
        n -= 1
    return (int(m.group(3)) + 1) * 12 + n


def _f(value, default=0.0) -> float:
    try:
        return float(str(value).strip().split()[0])
    except (ValueError, IndexError, AttributeError):
        return default


def _i(value, default=0) -> int:
    try:
        return int(float(str(value).strip().split()[0]))
    except (ValueError, IndexError, AttributeError):
        return default


# ---------------------------------------------------------------------------
# Pre-processing: comments, #define and #include
# ---------------------------------------------------------------------------
def _read_text(path: str) -> str:
    with open(path, "rb") as fh:
        raw = fh.read()
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1", errors="replace")


def preprocess(root_path: str) -> str:
    root_dir = os.path.dirname(os.path.abspath(root_path))
    defines: dict[str, str] = {}
    out: list[str] = []

    def subst(text: str) -> str:
        if "$" not in text:
            return text
        res = []
        i = 0
        n = len(text)
        while i < n:
            ch = text[i]
            if ch == "$":
                m = re.match(r"\$[A-Za-z0-9_]+", text[i:])
                if m:
                    cand = m.group(0)
                    for length in range(len(cand), 1, -1):
                        name = cand[:length]
                        if name in defines:
                            res.append(defines[name])
                            i += length
                            break
                    else:
                        res.append(ch)
                        i += 1
                    continue
            res.append(ch)
            i += 1
        return "".join(res)

    def process(path: str, depth: int) -> None:
        if depth > 32:
            raise SfzError("Too many nested #include files.")
        try:
            text = _read_text(path)
        except OSError as exc:
            raise SfzError(f"Missing file: {path}") from exc
        text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
        for line in text.splitlines():
            cut = line.find("//")
            if cut >= 0:
                line = line[:cut]
            pos = 0
            while True:
                m = DIRECTIVE_RE.search(line, pos)
                if not m:
                    rest = line[pos:]
                    if rest.strip():
                        out.append(subst(rest))
                    break
                before = line[pos:m.start()]
                if before.strip():
                    out.append(subst(before))
                if m.group(1) == "define":
                    dm = re.match(r"\s*(\$[A-Za-z0-9_]+)\s*(.*)$", line[m.end():])
                    if dm:
                        defines[dm.group(1)] = subst(dm.group(2).strip())
                    break
                im = re.match(r'\s*"([^"]*)"', line[m.end():])
                if not im:
                    break
                inc = subst(im.group(1)).replace("\\", "/")
                inc_path = inc if os.path.isabs(inc) else os.path.normpath(os.path.join(root_dir, inc))
                if os.path.exists(inc_path):
                    process(inc_path, depth + 1)
                pos = m.end() + im.end()

    process(os.path.abspath(root_path), 0)
    return "\n".join(out)


def tokenize(text: str):
    """Yield ('header', name) and ('opcode', name, value) in order."""
    marks = []
    for m in HEADER_RE.finditer(text):
        marks.append((m.start(), m.end(), "header", m.group(1).lower()))
    for m in OPCODE_RE.finditer(text):
        marks.append((m.start(1), m.end(), "opcode", m.group(1)))
    marks.sort()
    for idx, (start, end, kind, name) in enumerate(marks):
        if kind == "header":
            yield ("header", name)
        else:
            nxt = marks[idx + 1][0] if idx + 1 < len(marks) else len(text)
            value = text[end:nxt].strip()
            yield ("opcode", name, value)


# ---------------------------------------------------------------------------
# Curves
# ---------------------------------------------------------------------------
def builtin_curve(index: int, x: float) -> float:
    x = min(1.0, max(0.0, x))
    if index == 1:
        return 2 * x - 1
    if index == 2:
        return 1 - x
    if index == 3:
        return 1 - 2 * x
    if index == 4:
        return x * x
    if index == 5:
        return math.sqrt(x)
    if index == 6:
        return math.sqrt(1 - x)
    return x


class Curve:
    def __init__(self, points: dict[int, float]):
        pts = dict(points)
        pts.setdefault(0, 0.0)
        pts.setdefault(127, 1.0)
        self.xs = sorted(pts)
        self.ys = [pts[x] for x in self.xs]

    def __call__(self, x01: float) -> float:
        return float(np.interp(min(1.0, max(0.0, x01)) * 127, self.xs, self.ys))


# ---------------------------------------------------------------------------
# Regions
# ---------------------------------------------------------------------------
class Region:
    __slots__ = (
        "id", "lokey", "hikey", "lovel", "hivel", "lorand", "hirand", "seq_length", "seq_position",
        "cc_ranges", "sw_last", "trigger", "group", "off_by", "off_time", "polyphony", "note_polyphony",
        "volume_db", "amplitude", "amp_cc", "vol_cc", "pan", "pan_cc", "veltrack", "velcurve",
        "xfin", "xfout", "xf_power", "offset", "end", "delay", "pitch_keycenter", "pitch_keytrack",
        "transpose", "tune", "sample", "silent", "label", "pitch_random", "amp_random",
    )


def build_region(op: dict, idx: int, sample_root: str, default_path: str, curves: dict) -> Region | None:
    r = Region()
    r.id = idx
    key = parse_key(op.get("key"))
    if key is not None:
        r.lokey = r.hikey = key
        keycenter_default = key
    else:
        r.lokey = parse_key(op.get("lokey"))
        r.hikey = parse_key(op.get("hikey"))
        if r.lokey is None and "lokey" in op:
            return None
        if r.hikey is None and "hikey" in op:
            return None
        r.lokey = 0 if r.lokey is None else r.lokey
        r.hikey = 127 if r.hikey is None else r.hikey
        keycenter_default = 60
    if ("key" in op and key is None):
        return None
    r.lovel = _i(op.get("lovel", 0), 0)
    r.hivel = _i(op.get("hivel", 127), 127)
    r.lorand = _f(op.get("lorand", 0), 0.0)
    r.hirand = _f(op.get("hirand", 1), 1.0)
    r.seq_length = max(1, _i(op.get("seq_length", 1), 1))
    r.seq_position = max(1, _i(op.get("seq_position", 1), 1))
    ranges: dict[int, list] = {}
    for k, v in op.items():
        m = re.fullmatch(r"(lo|hi)(hd)?cc(\d+)", k)
        if m:
            cc = int(m.group(3))
            val = _f(v) * (127.0 if m.group(2) else 1.0)
            entry = ranges.setdefault(cc, [0.0, 127.0])
            entry[0 if m.group(1) == "lo" else 1] = val
    r.cc_ranges = [(cc, lo, hi) for cc, (lo, hi) in ranges.items()]
    r.sw_last = parse_key(op.get("sw_last")) if "sw_last" in op else None
    r.trigger = op.get("trigger", "attack").strip().lower()
    r.group = _i(op.get("group", 0), 0)
    off_by = op.get("off_by")
    r.off_by = _i(off_by) if off_by not in (None, "") else None
    if r.off_by is not None and r.off_by < 0:
        r.off_by = None
    off_mode = op.get("off_mode", "").strip().lower()
    if "off_time" in op:
        r.off_time = max(0.001, _f(op.get("off_time"), FAST_RELEASE))
    elif off_mode == "normal":
        r.off_time = max(0.001, _f(op.get("ampeg_release", 0.03), 0.03))
    else:
        r.off_time = FAST_RELEASE
    r.polyphony = _i(op.get("polyphony", 0), 0) or None
    r.note_polyphony = _i(op.get("note_polyphony", 0), 0) or None
    r.volume_db = sum(_f(op.get(k, 0)) for k in ("volume", "group_volume", "master_volume", "global_volume"))
    amp = 1.0
    for k in ("amplitude", "group_amplitude", "master_amplitude", "global_amplitude"):
        if k in op:
            amp *= _f(op[k], 100) / 100.0
    r.amplitude = amp
    amp_cc, vol_cc, pan_cc = [], [], []
    for k, v in op.items():
        m = re.fullmatch(r"amplitude_oncc(\d+)", k) or re.fullmatch(r"amplitude_cc(\d+)", k)
        if m:
            cc = int(m.group(1))
            amp_cc.append((cc, _f(v) / 100.0, _curve_for(op, "amplitude_curvecc", cc, curves)))
            continue
        m = re.fullmatch(r"(?:volume|gain)_oncc(\d+)", k)
        if m:
            cc = int(m.group(1))
            vol_cc.append((cc, _f(v), _curve_for(op, "volume_curvecc", cc, curves)))
            continue
        m = re.fullmatch(r"pan_oncc(\d+)", k) or re.fullmatch(r"pan_cc(\d+)", k)
        if m:
            cc = int(m.group(1))
            pan_cc.append((cc, _f(v) / 100.0, _curve_for(op, "pan_curvecc", cc, curves)))
    r.amp_cc, r.vol_cc, r.pan_cc = amp_cc, vol_cc, pan_cc
    r.pan = _f(op.get("pan", 0)) / 100.0
    r.veltrack = _f(op.get("amp_veltrack", 100), 100.0) / 100.0
    points = {}
    for k, v in op.items():
        m = re.fullmatch(r"amp_velcurve_(\d+)", k)
        if m:
            points[int(m.group(1))] = _f(v)
    r.velcurve = Curve(points) if points else None
    r.xfin = (_i(op["xfin_lovel"]), _i(op.get("xfin_hivel", 127), 127)) if "xfin_lovel" in op else None
    r.xfout = (_i(op["xfout_lovel"]), _i(op.get("xfout_hivel", 127), 127)) if "xfout_lovel" in op else None
    r.xf_power = op.get("xf_velcurve", "power").strip().lower() != "gain"
    r.offset = max(0, _i(op.get("offset", 0), 0))
    r.end = _i(op["end"]) if "end" in op else None
    r.delay = max(0.0, _f(op.get("delay", 0)))
    r.pitch_keycenter = parse_key(op.get("pitch_keycenter")) if "pitch_keycenter" in op else keycenter_default
    if r.pitch_keycenter is None:
        r.pitch_keycenter = keycenter_default
    r.pitch_keytrack = _f(op.get("pitch_keytrack", 100), 100.0)
    r.transpose = _f(op.get("transpose", 0))
    r.tune = _f(op.get("tune", op.get("pitch", 0)))
    r.pitch_random = max(0.0, min(100.0, _f(op.get("pitch_random", 0))))
    r.amp_random = max(0.0, min(12.0, _f(op.get("amp_random", 0))))
    r.label = (op.get("region_label") or op.get("group_label") or "").strip()
    sample = (op.get("sample") or "").strip()
    r.silent = (not sample) or sample.startswith("*") or (r.end is not None and r.end < 0)
    if not r.silent:
        rel = (default_path + sample).replace("\\", "/")
        r.sample = rel if os.path.isabs(rel) else os.path.normpath(os.path.join(sample_root, rel))
    else:
        r.sample = None
    return r


def _curve_for(op: dict, prefix: str, cc: int, curves: dict):
    idx = op.get(f"{prefix}{cc}")
    if idx is None:
        return lambda x: x
    i = _i(idx, 0)
    if i in curves:
        return curves[i]
    return lambda x, i=i: builtin_curve(i, x)


# ---------------------------------------------------------------------------
# The kit
# ---------------------------------------------------------------------------
class SampleCache:
    def __init__(self, budget_bytes: int):
        self.budget = budget_bytes
        self.used = 0
        self.items: OrderedDict = OrderedDict()
        self.lock = threading.Lock()
        self.loading: dict = {}

    def get(self, key):
        with self.lock:
            item = self.items.get(key)
            if item is not None:
                self.items.move_to_end(key)
            return item

    def put(self, key, arr):
        with self.lock:
            if key in self.items:
                return
            self.items[key] = arr
            self.used += arr.nbytes
            while self.used > self.budget and len(self.items) > 1:
                _, old = self.items.popitem(last=False)
                self.used -= old.nbytes


def _resample(data: np.ndarray, sr_in: float, sr_out: float) -> np.ndarray:
    """data: (frames, ch) float32."""
    if abs(sr_in - sr_out) < 1e-6:
        return data
    try:
        import soxr

        return np.asarray(soxr.resample(data, sr_in, sr_out, quality="HQ"), dtype=np.float32)
    except ImportError:
        n_out = max(1, int(round(data.shape[0] * sr_out / sr_in)))
        x_old = np.arange(data.shape[0], dtype=np.float64)
        x_new = np.linspace(0, data.shape[0] - 1, n_out)
        return np.stack([np.interp(x_new, x_old, data[:, c]) for c in range(data.shape[1])], axis=1).astype(np.float32)


def default_cache_mb() -> int:
    """About a quarter of the computer's memory, between 1 and 6 GB."""
    total_mb = 8192
    try:
        if os.name == "nt":
            import ctypes

            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("sullAvailExtendedVirtual", ctypes.c_ulonglong)]

            stat = MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
                total_mb = stat.ullTotalPhys // (1024 * 1024)
        else:
            total_mb = (os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")) // (1024 * 1024)
    except Exception:  # noqa: BLE001
        pass
    return int(min(6144, max(1024, total_mb // 4)))


_SHARED_CACHE: SampleCache | None = None
_SHARED_LOCK = threading.Lock()
_FILE_RATES: dict[str, int] = {}


def shared_cache() -> SampleCache:
    """One memory budget for every kit that is open."""
    global _SHARED_CACHE
    with _SHARED_LOCK:
        if _SHARED_CACHE is None:
            _SHARED_CACHE = SampleCache(default_cache_mb() * 1024 * 1024)
        return _SHARED_CACHE


class SfzKit:
    def __init__(self, path: str, cache_mb: int | None = None, log=print):
        self.path = os.path.abspath(path)
        self.name = os.path.splitext(os.path.basename(path))[0]
        self.log = log
        self.cache = SampleCache(cache_mb * 1024 * 1024) if cache_mb else shared_cache()
        self.missing: set = set()
        self.cc_defaults: dict[int, float] = {}
        self.cc_labels: dict[int, str] = {}
        self.note_offset = 0
        self.sw_default = None
        self.sw_range = None
        self.regions: list[Region] = []
        self.by_key: dict[int, list[Region]] = {}
        self._parse()
        self._preload_stop = threading.Event()

    # -- parsing --------------------------------------------------------------
    def _parse(self) -> None:
        text = preprocess(self.path)
        sample_root = os.path.dirname(self.path)
        control: dict = {}
        levels = {"global": {}, "master": {}, "group": {}}
        current = "control"
        region_ops: dict | None = None
        curves: dict = {}
        curve_ops: dict | None = None
        pending: list = []

        def flush_region():
            nonlocal region_ops
            if region_ops is not None:
                merged = {**levels["global"], **levels["master"], **levels["group"], **region_ops}
                pending.append(merged)
            region_ops = None

        def flush_curve():
            nonlocal curve_ops
            if curve_ops is not None:
                idx = _i(curve_ops.get("curve_index", -1), -1)
                pts = {int(k[1:]): _f(v) for k, v in curve_ops.items() if re.fullmatch(r"v\d+", k)}
                if idx >= 0 and pts:
                    curves[idx] = Curve(pts)
            curve_ops = None

        for tok in tokenize(text):
            if tok[0] == "header":
                name = tok[1]
                if current == "region":
                    flush_region()
                if current == "curve":
                    flush_curve()
                if name == "global":
                    levels = {"global": {}, "master": {}, "group": {}}
                elif name == "master":
                    levels["master"] = {}
                    levels["group"] = {}
                elif name == "group":
                    levels["group"] = {}
                elif name == "region":
                    region_ops = {}
                elif name == "curve":
                    curve_ops = {}
                current = name
                continue
            _, key, value = tok
            if current == "region" and region_ops is not None:
                region_ops[key] = value
            elif current in levels:
                levels[current][key] = value
            elif current == "control":
                control[key] = value
            elif current == "curve" and curve_ops is not None:
                curve_ops[key] = value
        if current == "region":
            flush_region()
        if current == "curve":
            flush_curve()

        default_path = (control.get("default_path") or "").replace("\\", "/")
        if default_path and not default_path.endswith("/"):
            default_path += "/"
        self.note_offset = _i(control.get("note_offset", 0)) + 12 * _i(control.get("octave_offset", 0))
        for k, v in control.items():
            m = re.fullmatch(r"set_(hd)?cc(\d+)", k)
            if m:
                cc = int(m.group(2))
                self.cc_defaults[cc] = min(1.0, max(0.0, _f(v) if m.group(1) else _f(v) / 127.0))
                continue
            m = re.fullmatch(r"label_cc(\d+)", k)
            if m:
                self.cc_labels[int(m.group(1))] = v.strip()

        for idx, op in enumerate(pending):
            if self.sw_default is None and "sw_default" in op:
                self.sw_default = parse_key(op["sw_default"])
            if self.sw_range is None and "sw_lokey" in op:
                lo, hi = parse_key(op.get("sw_lokey")), parse_key(op.get("sw_hikey", op.get("sw_lokey")))
                if lo is not None and hi is not None:
                    self.sw_range = (lo, hi)
            r = build_region(op, idx, sample_root, default_path, curves)
            if r is None:
                continue
            if r.trigger not in ("attack", "first", "legato"):
                continue
            self.regions.append(r)
            for k in range(max(0, r.lokey), min(127, r.hikey) + 1):
                self.by_key.setdefault(k, []).append(r)
        if not self.regions:
            raise SfzError("This SFZ file has no playable sounds.")

    # -- info ---------------------------------------------------------------------
    def controls(self) -> list[dict]:
        out = []
        for cc, label in sorted(self.cc_labels.items()):
            out.append({"cc": cc, "label": label, "default": round(self.cc_defaults.get(cc, 0.0), 4)})
        return out

    def keys(self) -> list[int]:
        return sorted(k for k, regs in self.by_key.items() if any(not r.silent for r in regs))

    def labels(self) -> dict[int, str]:
        """Names the kit gives its sounds (group_label / region_label), by key."""
        out: dict[int, str] = {}
        for r in self.regions:
            if r.silent or not r.label or r.lokey != r.hikey:
                continue
            out.setdefault(r.lokey, r.label)
        return out

    # -- samples ------------------------------------------------------------------
    def load_sample(self, path: str, sr: int, rate: float = 1.0):
        key = (path, sr, round(rate, 6))
        arr = self.cache.get(key)
        if arr is not None:
            return arr
        if path in self.missing:
            return None
        import soundfile as sf

        try:
            data, file_sr = sf.read(path, dtype="float32", always_2d=True)
        except Exception as exc:  # noqa: BLE001
            self.missing.add(path)
            self.log(f"Kit sample couldn't be read: {path} ({exc})")
            return None
        if data.shape[1] > 2:
            data = data[:, :2]
        _FILE_RATES[path] = int(file_sr)
        data = _resample(data, float(file_sr), float(sr) / rate)
        arr = np.ascontiguousarray(data.T, dtype=np.float32)
        self.cache.put(key, arr)
        return arr

    @staticmethod
    def _frames(path: str, count: int, sr: int, rate: float) -> int:
        """A position given in the sample file's own frames, in output frames."""
        file_sr = _FILE_RATES.get(path) or sr
        return int(round(count * (sr / rate) / file_sr))

    def _rate(self, r: Region, note: int) -> float:
        semis = (note - r.pitch_keycenter) * r.pitch_keytrack / 100.0 + r.transpose + r.tune / 100.0
        return 2.0 ** (semis / 12.0) if abs(semis) > 1e-4 else 1.0

    def preload(self, sr: int, keys: list[int] | None = None, threads: int = 3) -> None:
        """Decode samples in the background so the first playback is quick."""
        self._preload_stop.set()
        stop = threading.Event()
        self._preload_stop = stop
        order = keys or [36, 38, 42, 46, 44, 49, 51, 48, 45, 43, 37, 40, 57, 53, 41, 47, 55, 52]
        jobs = []
        seen = set()
        for k in order + [k for k in self.by_key if k not in order]:
            for r in self.by_key.get(k, []):
                if r.silent or r.sample in seen:
                    continue
                if r.sw_last is not None and self.sw_default is not None and r.sw_last != self.sw_default:
                    continue
                seen.add(r.sample)
                rate = self._rate(r, k)
                jobs.append((r.sample, rate))
                if r.pitch_random > 0:
                    for step in (-1, 1):
                        jobs.append((r.sample, rate * 2.0 ** (step * r.pitch_random / 1200.0)))
        lock = threading.Lock()

        def work():
            while not stop.is_set():
                with lock:
                    if not jobs:
                        return
                    path, rate = jobs.pop(0)
                if self.cache.used > self.cache.budget * 0.9:
                    return
                self.load_sample(path, sr, rate)

        for _ in range(threads):
            threading.Thread(target=work, daemon=True).start()

    @staticmethod
    def _fits(r, sw, cc) -> bool:
        """Whether a region answers to the current keyswitch and controller values."""
        if r.sw_last is not None and r.sw_last != sw:
            return False
        for num, lo, hi in r.cc_ranges:
            val = cc.get(num, 0.0) * 127.0
            if val < lo - 1e-6 or val > hi + 1e-6:
                return False
        return True

    @staticmethod
    def _take_layout(candidates) -> tuple[int, list]:
        """How a sound's recordings are told apart: round-robin steps x random slots."""
        steps = max((r.seq_length for r in candidates), default=1)
        slots = sorted({round(r.lorand, 6) for r in candidates if r.lorand > 0.0 or r.hirand < 1.0})
        return steps, slots

    def _one_take(self, candidates, take: int) -> list:
        """The regions that make up recording number `take` (0-based) of a hit.

        Round-robin steps count first, then random slots, so every combination is
        reachable. A velocity layer with fewer recordings wraps around."""
        steps, slots = self._take_layout(candidates)
        slot = slots[(take // max(1, steps)) % len(slots)] if slots else None
        out = []
        for r in candidates:
            if r.seq_length > 1 and (take % r.seq_length) != r.seq_position - 1:
                continue
            if slot is not None and (r.lorand > 0.0 or r.hirand < 1.0) and round(r.lorand, 6) != slot:
                continue
            out.append(r)
        return out

    def take_count(self, key: int, cc_overrides: dict | None = None) -> int:
        """How many recordings (variations) a key has, at the velocity where it has the most."""
        cc = dict(self.cc_defaults)
        for k, v in (cc_overrides or {}).items():
            cc[int(k)] = min(1.0, max(0.0, float(v)))
        regions = [r for r in self.by_key.get(int(key) + self.note_offset, ()) if not r.silent]
        best = 0
        for vel in list(range(8, 128, 8)) + [127]:
            cands = [r for r in regions if r.lovel <= vel <= r.hivel and self._fits(r, self.sw_default, cc)]
            if cands:
                steps, slots = self._take_layout(cands)
                best = max(best, steps * max(1, len(slots)))
        return best

    def calibrate(self, sr: int, target: float = 0.6, refs=None) -> float:
        """Pick an output gain so a hard hit of the reference sounds peaks around `target`.

        The default references are the snare and kick; a percussion kit names its own.
        """
        candidates = [int(k) for k in refs] if refs else [38, 36, 40, 37, 42]
        cache_key = (int(sr), tuple(candidates), round(float(target), 4))
        cached = getattr(self, "_calibration", {})
        if cache_key in cached:
            return cached[cache_key]
        found = [k for k in candidates if any(not r.silent for r in self.by_key.get(k, ()))][:2]
        gain = 1.0
        if found:
            events = [(0.02 + i * 0.6, "note", k, 120) for i, k in enumerate(found)]
            audio = self.render(events, 0.02 + len(found) * 0.6, sr, seed=1, vary=False)
            peak = float(np.abs(audio).max())
            if peak > 1e-6:
                gain = min(2.0, max(0.05, target / peak))
        cached[cache_key] = gain
        self._calibration = cached
        return gain

    # -- rendering ------------------------------------------------------------------
    def _gains(self, r: Region, vel: int, cc: dict) -> tuple[float, float]:
        v = vel / 127.0
        curve = r.velcurve(v) if r.velcurve else v * v
        vt = r.veltrack
        velgain = (1 - vt) + vt * curve if vt >= 0 else 1 + vt * curve
        gain = r.amplitude * velgain * (10 ** (r.volume_db / 20.0))
        for num, depth, fn in r.amp_cc:
            gain *= depth * fn(cc.get(num, 0.0))
        db = 0.0
        for num, depth, fn in r.vol_cc:
            db += depth * fn(cc.get(num, 0.0))
        if db:
            gain *= 10 ** (db / 20.0)
        if r.xfin:
            lo, hi = r.xfin
            x = 1.0 if vel >= hi else 0.0 if vel <= lo else (vel - lo) / max(1, hi - lo)
            gain *= math.sqrt(x) if r.xf_power else x
        if r.xfout:
            lo, hi = r.xfout
            x = 1.0 if vel <= lo else 0.0 if vel >= hi else 1 - (vel - lo) / max(1, hi - lo)
            gain *= math.sqrt(x) if r.xf_power else x
        pan = r.pan
        for num, depth, fn in r.pan_cc:
            pan += depth * fn(cc.get(num, 0.0))
        pan = min(1.0, max(-1.0, pan))
        return gain * min(1.0, 1.0 - pan), gain * min(1.0, 1.0 + pan)

    def render(self, events, duration: float, sr: int, cc_overrides: dict | None = None, seed: int | None = None,
               vary: bool = True, variations: str = "cycle", wash=None, blend=None):
        """events: sorted list of (seconds, 'note', note, vel[, gain[, take[, ring]]]),
        (seconds, 'cc', number, value127) or (seconds, 'choke', note, 0).

        A choke is a hand grabbing the cymbal: everything that key is playing fades out
        within CHOKE_FADE. ring (seconds) shortens a hit: it sounds as recorded for the first
        30% of that time, then dies away (exponentially) to silence (-60 dB) at `ring`.

        blend: {"hat": {"keys": [...], "amount": 0..1}, "cym": {...}}. When an open hi-hat
        (or a crash) is hit while it still rings from its last hit, that ring fades out slowly
        under the new hit and the new hit starts softer, the way an open hi-hat played in
        eighths sounds like one continuous wash. amount 0 (or no blend) keeps every hit
        separate. wash (a list of keys) is the older form: the hi-hat at 0.8.

        take (0-based) makes the hit always play that one recording of the sound
        (see take_count), with no random tuning or level.

        vary=False turns off pitch_random/amp_random (used when measuring the kit's level).
        variations="random" picks round robins (seq_length) at random instead of in turn,
        never the same one three times in a row. Sequences that already pick at random
        within each step (lorand/hirand, like a shaker's down-up strokes) stay in order.
        """
        frames = max(1, int(round(duration * sr)))
        out = np.zeros((2, frames), dtype=np.float32)
        cc = dict(self.cc_defaults)
        for k, v in (cc_overrides or {}).items():
            cc[int(k)] = min(1.0, max(0.0, float(v)))
        sw = self.sw_default
        counters: dict[int, int] = {}
        rng = random.Random(seed)
        shuffle = variations == "random"
        seq_history: dict[tuple, list] = {}
        voices: list[dict] = []
        by_offby: dict[int, list] = {}
        by_group_key: dict[tuple, list] = {}
        by_group: dict[int, list] = {}
        by_key: dict[int, list] = {}
        if blend is None and wash:
            blend = {"hat": {"keys": list(wash), "amount": 0.8}}
        blend_of: dict[int, tuple] = {}
        for kind, spec in (blend or {}).items():
            amount = min(1.0, max(0.0, float(spec.get("amount", 0.0) or 0.0)))
            if kind in BLEND_KINDS and amount > 0.0:
                for k in spec.get("keys") or ():
                    blend_of[int(k)] = (kind, amount)
        blend_prev: dict = {}  # "hat" or ("cym", key) -> (frame, voices) of its last hit

        def stop_voice(v, frame, fade=None):
            """Start fading a voice out. A later stop can only make it end sooner."""
            fade = v["fade"] if fade is None else max(1, int(fade))
            end = frame + fade
            if v["end_at"] is not None and end >= v["end_at"]:
                return
            v["stops"].append((frame, fade))
            v["end_at"] = end
            if v["stop"] is None:
                v["stop"] = frame

        for ev in events:
            t, kind, a, b = ev[0], ev[1], ev[2], ev[3]
            frame = int(round(t * sr))
            ring = float(ev[6]) if kind == "note" and len(ev) > 6 and ev[6] else 0.0
            if kind == "cc":
                cc[int(a)] = min(1.0, max(0.0, b / 127.0))
                continue
            if kind == "choke":
                for v in by_key.get(int(a) + self.note_offset, ()):
                    if v["start"] <= frame:
                        stop_voice(v, frame, CHOKE_FADE * sr)
                continue
            hit_gain = float(ev[4]) if len(ev) > 4 and ev[4] is not None else 1.0
            if hit_gain <= 1e-6:
                continue
            note = int(a) + self.note_offset
            vel = max(1, min(127, int(b)))
            take = int(ev[5]) if len(ev) > 5 and ev[5] is not None else -1
            hit_vary = vary and take < 0
            if self.sw_range and self.sw_range[0] <= note <= self.sw_range[1]:
                sw = note
            rnd = rng.random()
            seq_pick: dict[int, int] = {}

            def pick(length: int) -> int:
                if length not in seq_pick:
                    hist = seq_history.setdefault((note, length), [])
                    choice = rng.randrange(length)
                    if len(hist) >= 2 and hist[-1] == hist[-2] == choice:
                        choice = (choice + 1 + rng.randrange(length - 1)) % length
                    hist.append(choice)
                    del hist[:-2]
                    seq_pick[length] = choice
                return seq_pick[length]

            candidates = [r for r in self.by_key.get(note, ()) if r.lovel <= vel <= r.hivel and self._fits(r, sw, cc)]
            if take >= 0:
                triggered = self._one_take(candidates, take)
            else:
                triggered = []
                for r in candidates:
                    count = counters.get(r.id, 0)
                    counters[r.id] = count + 1
                    if r.seq_length > 1:
                        in_order = not shuffle or r.lorand > 0.0 or r.hirand < 1.0
                        step = (count % r.seq_length) if in_order else pick(r.seq_length)
                        if step != r.seq_position - 1:
                            continue
                    if not (r.lorand <= rnd < r.hirand or (r.hirand >= 1.0 and rnd >= r.lorand)):
                        continue
                    triggered.append(r)
            if not triggered:
                continue
            blending = blend_of.get(int(a))
            track = None
            ringing = ()
            soften = None
            if blending is not None:
                kind, amount = blending
                spec = BLEND_KINDS[kind]
                track = kind if kind == "hat" else (kind, int(a))
                prev = blend_prev.get(track)
                if prev is not None:
                    gap = (frame - prev[0]) / sr
                    ringing = [v for v in prev[1] if v["stop"] is None]
                    if ringing and 0.0 < gap < spec["max_gap"]:
                        # The last hit keeps ringing under this one and fades away over the
                        # next hit or two; this hit's attack is gentler the closer it follows.
                        base, per_gap, lo, hi = spec["release"]
                        release = min(hi, max(lo, base + per_gap * gap)) * (0.4 + 0.75 * amount)
                        for v in ringing:
                            stop_voice(v, frame, release * sr)
                        near = spec["near"]
                        closeness = min(1.0, max(0.0, (gap - near) / (spec["max_gap"] - near)))
                        softest = 1.0 - (1.0 - spec["floor"]) * amount
                        g0 = softest + (1.0 - softest) * closeness
                        if g0 < 0.99:
                            soften = (max(1, int(spec["span"] * sr)), g0)
                    else:
                        ringing = ()
            fading = {id(v) for v in ringing}
            for g in {r.group for r in triggered}:
                for v in by_offby.get(g, ()):
                    if v["start"] <= frame and id(v) not in fading:
                        stop_voice(v, frame)
            new_voices = []
            for r in triggered:
                if r.note_polyphony:
                    alive = [v for v in by_group_key.get((r.group, note), ()) if v["stop"] is None and v["start"] <= frame]
                    while len(alive) >= r.note_polyphony:
                        stop_voice(alive.pop(0), frame)
                if r.polyphony:
                    alive = [v for v in by_group.get(r.group, ()) if v["stop"] is None and v["start"] <= frame]
                    while len(alive) >= r.polyphony:
                        stop_voice(alive.pop(0), frame)
                if r.silent:
                    continue
                gl, gr = self._gains(r, vel, cc)
                gl *= hit_gain
                gr *= hit_gain
                if hit_vary and r.amp_random > 0:
                    drop = 10 ** (-rng.random() * r.amp_random / 20.0)
                    gl *= drop
                    gr *= drop
                if gl <= 1e-6 and gr <= 1e-6:
                    continue
                rate = self._rate(r, note)
                if hit_vary and r.pitch_random > 0:
                    # Three fixed detunings keep the number of cached copies small.
                    step = rng.choice((-1, 0, 1))
                    if step:
                        rate *= 2.0 ** (step * r.pitch_random / 1200.0)
                data = self.load_sample(r.sample, sr, rate)
                if data is None:
                    continue
                v = {
                    "start": frame + int(round(r.delay * sr)),
                    "data": data,
                    "offset": self._frames(r.sample, r.offset, sr, rate) if r.offset else 0,
                    "end": self._frames(r.sample, r.end, sr, rate) if r.end else r.end,
                    "gl": gl,
                    "gr": gr,
                    "stop": None,
                    "stops": [],
                    "end_at": None,
                    "fade": max(1, int(r.off_time * sr)),
                    "attack": soften,
                    "decay": None,
                }
                if ring > 0.0:
                    # Shorter ring: as recorded at first, then an exponential fade to -60 dB.
                    hold = ring * 0.3
                    v["decay"] = (int(hold * sr), max(1.0, (ring - hold) * sr / 6.9))
                    stop_voice(v, v["start"] + int(ring * sr), 0.02 * sr)
                voices.append(v)
                new_voices.append(v)
                by_key.setdefault(note, []).append(v)
                if r.off_by is not None:
                    by_offby.setdefault(r.off_by, []).append(v)
                if r.note_polyphony:
                    by_group_key.setdefault((r.group, note), []).append(v)
                if r.polyphony:
                    by_group.setdefault(r.group, []).append(v)
            if track is not None and new_voices:
                blend_prev[track] = (frame, new_voices)
        for v in voices:
            data = v["data"]
            s0 = v["start"]
            first = v["offset"]
            last = data.shape[1]
            if v["end"] is not None and v["end"] > 0:
                last = min(last, v["end"])
            out_end = s0 + (last - first)
            if v["end_at"] is not None:
                out_end = min(out_end, v["end_at"])
            a = max(0, s0)
            b = min(frames, out_end)
            if b <= a:
                continue
            src_a = first + (a - s0)
            chunk = data[:, src_a:src_a + (b - a)]
            b = a + chunk.shape[1]
            if b <= a:
                continue
            env = None
            if v["attack"] is not None:
                span, g0 = v["attack"]
                ea, eb = max(a, s0), min(b, s0 + span)
                if eb > ea:
                    env = np.ones(b - a, dtype=np.float32)
                    x = np.arange(ea - s0, eb - s0, dtype=np.float32) / span
                    env[ea - a: eb - a] = g0 + (1.0 - g0) * (0.5 - 0.5 * np.cos(np.pi * x))
            if v["decay"] is not None:
                hold, tau = v["decay"]
                da = max(a, s0 + hold)
                if da < b:
                    if env is None:
                        env = np.ones(b - a, dtype=np.float32)
                    x = np.arange(da - s0 - hold, b - s0 - hold, dtype=np.float32)
                    env[da - a:] *= np.exp(-x / tau).astype(np.float32)
            for stop, fade in v["stops"]:
                if stop >= b:
                    continue
                fs = max(stop, a)
                if env is None:
                    env = np.ones(b - a, dtype=np.float32)
                ramp = 1.0 - np.arange(fs - stop, b - stop, dtype=np.float32) / fade
                np.clip(ramp, 0.0, 1.0, out=ramp)
                part = env[fs - a:]
                np.minimum(part, ramp, out=part)
            if env is not None:
                chunk = chunk * env
            gl, gr = v["gl"], v["gr"]
            if chunk.shape[0] == 1:
                out[0, a:b] += chunk[0] * gl
                out[1, a:b] += chunk[0] * gr
            else:
                out[0, a:b] += chunk[0] * gl
                out[1, a:b] += chunk[1] * gr
        return out


def apply_kit_rules(notes, ccs, note_map: dict | None, hihat: dict | None):
    """Remap notes for a kit. hihat rules pick an articulation from CC4 at hit time.

    notes: [[t, n, v], ...]; ccs: [[t, cc, value], ...]
    """
    note_map = {int(k): int(v) for k, v in (note_map or {}).items()}
    rules = {}
    cc_num = 4
    if hihat:
        cc_num = int(hihat.get("cc", 4))
        rules = {int(k): v for k, v in (hihat.get("rules") or {}).items()}
    pedal = sorted((float(c[0]), int(c[2])) for c in (ccs or []) if int(c[1]) == cc_num)
    times = [p[0] for p in pedal]
    out = []
    import bisect

    for t, n, v in notes:
        n = int(n)
        mapped = None
        if rules and pedal and n in rules:
            i = bisect.bisect_right(times, float(t) + 1e-4) - 1
            if i >= 0:
                value = pedal[i][1]
                for lo, hi, target in rules[n]:
                    if lo <= value <= hi:
                        mapped = int(target)
                        break
        if mapped is None:
            mapped = note_map.get(n, n)
        out.append([float(t), mapped, int(v)])
    return out
