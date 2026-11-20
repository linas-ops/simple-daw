"""Simple DAW plugin engine.

Runs in its own process (started by server.py) so that a plugin that crashes
can never take the rest of the app down. It hosts one drum plugin at a time
with DawDreamer, or one main SFZ kit plus any other kits that single drums
borrow sounds from, and turns lists of drum hits into audio.

Messages are plain dicts sent over a multiprocessing Pipe. Every request gets
exactly one reply: {"ok": True, ...} or {"ok": False, "error": "..."}.
"""
from __future__ import annotations

import base64
import os
import struct
import sys
import tempfile
import time
import traceback
import zlib

BLOCK_SIZE = 512
MAX_KITS = 8  # kits kept open at once (the main kit plus ones single drums borrow from)
COMMON_KEYS = [36, 38, 42, 46, 44, 49, 51, 48, 45, 43, 37, 40, 57, 53, 41, 47, 55, 52]
NOTE_CHANNEL = 9  # MIDI channel 10, the drum channel


def _vlq(value: int) -> bytes:
    out = [value & 0x7F]
    value >>= 7
    while value:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    return bytes(reversed(out))


def write_midi_file(path: str, events: list, ppq: int = 9600, bpm: float = 120.0) -> None:
    """Write a type-0 MIDI file. events: [(seconds, (status, data1, data2)), ...]."""
    us_per_quarter = int(round(60_000_000 / bpm))
    seconds_per_tick = (us_per_quarter / 1_000_000) / ppq
    # Note-offs (0x8n) sort before note-ons at the same instant.
    ordered = sorted(events, key=lambda e: (e[0], 0 if (e[1][0] & 0xF0) == 0x80 else 1))
    track = bytearray()
    track += _vlq(0) + bytes([0xFF, 0x51, 0x03]) + us_per_quarter.to_bytes(3, "big")
    last_tick = 0
    for seconds, msg in ordered:
        tick = max(last_tick, int(round(max(0.0, seconds) / seconds_per_tick)))
        track += _vlq(tick - last_tick) + bytes(msg)
        last_tick = tick
    track += _vlq(0) + bytes([0xFF, 0x2F, 0x00])
    header = b"MThd" + struct.pack(">IHHH", 6, 0, 1, ppq)
    with open(path, "wb") as fh:
        fh.write(header + b"MTrk" + struct.pack(">I", len(track)) + bytes(track))


def _choke_of(item) -> float:
    """Seconds from a hit to its choke (its 5th item), or 0 when it rings out."""
    if len(item) > 4 and item[4]:
        try:
            return max(0.0, float(item[4]))
        except (TypeError, ValueError):
            return 0.0
    return 0.0


def build_events(notes, ccs, t0: float, t_end: float):
    """Turn absolute-time hits/CCs into MIDI events relative to t0."""
    events = []
    # Group by note number so each note-off lands before that drum's next hit.
    by_note: dict[int, list] = {}
    for item in notes or []:
        if not isinstance(item, (list, tuple)) or len(item) < 3:
            continue
        t, n, v = float(item[0]), int(item[1]), int(item[2])
        if t0 - 1e-6 <= t < t_end:
            by_note.setdefault(n, []).append((t, v))
            choke = _choke_of(item)
            if choke and t + choke < t_end:
                # A cymbal choke is sent as polyphonic aftertouch, like a module does when you grab a cymbal.
                events.append((t + choke - t0, (0xA0 | NOTE_CHANNEL, n & 0x7F, 127)))
                events.append((t + choke + 0.06 - t0, (0xA0 | NOTE_CHANNEL, n & 0x7F, 0)))
    for n, hits in by_note.items():
        hits.sort()
        for i, (t, v) in enumerate(hits):
            rel = t - t0
            gap = (hits[i + 1][0] - t) if i + 1 < len(hits) else 1.0
            length = max(0.002, min(0.08, gap * 0.5))
            v = max(1, min(127, v))
            events.append((rel, (0x90 | NOTE_CHANNEL, n & 0x7F, v)))
            events.append((rel + length, (0x80 | NOTE_CHANNEL, n & 0x7F, 0)))
    last_value: dict[int, int] = {}
    valid_ccs = [c for c in (ccs or []) if isinstance(c, (list, tuple)) and len(c) >= 3]
    for t, c, v in sorted(valid_ccs, key=lambda x: x[0]):
        if t < t0:
            last_value[int(c)] = int(v)
        elif t < t_end:
            events.append((t - t0, (0xB0 | NOTE_CHANNEL, int(c) & 0x7F, int(v) & 0x7F)))
    for c, v in last_value.items():
        events.append((0.0, (0xB0 | NOTE_CHANNEL, c & 0x7F, v & 0x7F)))
    return events


class Host:
    def __init__(self) -> None:
        self.daw = None
        self.mode = None  # "plugin" or "sfz"
        self.kits: dict[str, dict] = {}  # absolute path -> {"kit": SfzKit, "opts": {...}, "used": time}
        self.main: str | None = None
        self.engine = None
        self.proc = None
        self.sample_rate = None
        self.path = None
        self.latency = 0
        self.tmpdir = tempfile.mkdtemp(prefix="simple-daw-")
        self.midi_path = os.path.join(self.tmpdir, "render.mid")
        self.state_path = os.path.join(self.tmpdir, "state.bin")

    # -- plugin lifecycle -------------------------------------------------
    def load(self, path: str, sample_rate: int, state_b64: str | None = None) -> dict:
        if not path or not os.path.exists(path):
            raise RuntimeError(f"Plugin file not found: {path}")
        if self.daw is None:
            import dawdreamer as daw  # imported on this process's main thread on purpose

            self.daw = daw
        self.unload()
        self.sample_rate = int(sample_rate)
        engine = self.daw.RenderEngine(self.sample_rate, BLOCK_SIZE)
        try:
            proc = engine.make_plugin_processor("drums", path)
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(
                "This plugin could not be opened. It may be 32-bit, missing files, "
                f"or not a VST instrument. ({exc})"
            ) from exc
        for fn in ("disable_nonmain_buses",):
            try:
                getattr(proc, fn)()
            except Exception:  # noqa: BLE001
                pass
        try:
            if proc.can_set_bus(0, 2):
                proc.set_bus(0, 2)
        except Exception:  # noqa: BLE001
            pass
        self.engine, self.proc, self.path = engine, proc, path
        self.mode = "plugin"
        if state_b64:
            self.set_state(state_b64)
        engine.load_graph([(proc, [])])
        try:
            self.latency = max(0, int(proc.get_latency_samples()))
        except Exception:  # noqa: BLE001
            self.latency = 0
        return {
            "name": os.path.splitext(os.path.basename(path.rstrip("\\/")))[0],
            "path": path,
            "latency": self.latency,
            "sampleRate": self.sample_rate,
        }

    def unload(self) -> None:
        self.proc = None
        self.engine = None
        self.path = None

    def _need_plugin(self) -> None:
        if self.proc is None:
            raise RuntimeError("No plugin is loaded.")

    def get_state(self) -> str:
        self._need_plugin()
        if os.path.exists(self.state_path):
            os.remove(self.state_path)
        self.proc.save_state(self.state_path)
        with open(self.state_path, "rb") as fh:
            return base64.b64encode(fh.read()).decode("ascii")

    def set_state(self, state_b64: str) -> None:
        self._need_plugin()
        with open(self.state_path, "wb") as fh:
            fh.write(base64.b64decode(state_b64))
        self.proc.load_state(self.state_path)

    def open_editor(self) -> str:
        self._need_plugin()
        self.proc.open_editor()  # blocks until the plugin window is closed
        return self.get_state()

    # -- sample kits (SFZ) -----------------------------------------------------
    @staticmethod
    def _kit_options(options: dict | None) -> dict:
        o = options or {}
        return {"noteMap": o.get("noteMap") or {}, "hihat": o.get("hihat") or None, "calibrate": o.get("calibrate") or None,
                "cc": o.get("cc") or {}}

    def _open_kit(self, path: str, options: dict | None = None) -> tuple[str, dict]:
        """Open a kit (or reuse it if it's already open). Several stay open at once."""
        import sfz

        if not path or not os.path.exists(path):
            raise RuntimeError(f"Kit file not found: {path}")
        ap = os.path.abspath(path)
        entry = self.kits.get(ap)
        if entry is None:
            entry = {"kit": sfz.SfzKit(ap, log=lambda *a: print(*a, file=sys.stderr)), "opts": self._kit_options(None), "used": 0.0}
            self.kits[ap] = entry
            extras = sorted((e["used"], p) for p, e in self.kits.items() if p not in (ap, self.main))
            while len(self.kits) > MAX_KITS and extras:
                self.kits.pop(extras.pop(0)[1], None)
        if options is not None:
            entry["opts"] = self._kit_options(options)
        entry["used"] = time.time()
        return ap, entry

    @staticmethod
    def _kit_gain(entry: dict, sr: int) -> float:
        cal = entry["opts"].get("calibrate") or {}
        return entry["kit"].calibrate(int(sr), target=float(cal.get("target", 0.6)), refs=cal.get("keys"))

    @staticmethod
    def _preload_keys(entry: dict, notes) -> list[int]:
        """The kit keys that the given drum notes will play (after the kit's note map)."""
        opts = entry["opts"]
        note_map = {int(k): int(v) for k, v in (opts.get("noteMap") or {}).items()}
        rules = (opts.get("hihat") or {}).get("rules") or {}
        keys = []
        for n in notes:
            keys.append(note_map.get(n, n))
            for rule in rules.get(str(n), []):
                keys.append(int(rule[2]))
        return list(dict.fromkeys(keys))

    def load_kit(self, path: str, sample_rate: int, options: dict | None = None) -> dict:
        ap, entry = self._open_kit(path, options or {})
        self.main = ap
        self.sample_rate = int(sample_rate)
        self.mode = "sfz"
        kit = entry["kit"]
        gain = self._kit_gain(entry, self.sample_rate)
        kit.preload(self.sample_rate, self._preload_keys(entry, COMMON_KEYS))
        return {
            "name": kit.name,
            "path": kit.path,
            "controls": kit.controls(),
            "keys": kit.keys(),
            "labels": {str(k): v for k, v in kit.labels().items()},
            "regions": len(kit.regions),
            "gain": round(gain, 4),
            "sampleRate": self.sample_rate,
        }

    def take_count(self, path: str, options: dict | None, note: int, raw: bool) -> dict:
        """How many recordings a drum has (in the kit that plays it)."""
        _, entry = self._open_kit(path, options)
        opts = entry["opts"]
        key = int(note) if raw else int({int(k): int(v) for k, v in (opts.get("noteMap") or {}).items()}.get(int(note), int(note)))
        return {"count": entry["kit"].take_count(key, opts.get("cc")), "key": key}

    def describe_kit(self, path: str, sample_rate: int, options: dict | None = None, preload=None) -> dict:
        """Open another kit so single drums can borrow its sounds."""
        _, entry = self._open_kit(path, options)
        kit = entry["kit"]
        if preload:
            kit.preload(int(sample_rate), self._preload_keys(entry, [int(n) for n in preload]))
        return {
            "name": kit.name,
            "path": kit.path,
            "keys": kit.keys(),
            "labels": {str(k): v for k, v in kit.labels().items()},
            "controls": kit.controls(),
        }

    @staticmethod
    def _wash_keys(opts: dict) -> set:
        """The keys that play this kit's open (or half-open) hi-hat, after its note map.
        A kit that maps the open hi-hat note to something else (like Percussion's tambourine)
        has none."""
        note_map = {int(k): int(v) for k, v in (opts.get("noteMap") or {}).items()}
        rules = (opts.get("hihat") or {}).get("rules") or {}
        keys = set()
        for ranges in rules.values():
            for lo, _hi, target in ranges:
                if int(lo) == 0:
                    keys.add(int(target))
        if rules or note_map.get(46, 46) == 46:
            keys.add(note_map.get(46, 46))
        return keys

    def render_kit(self, notes, ccs, start: float, preroll: float, length: float, sample_rate: int,
                   cc_overrides=None, routes=None, variations="cycle", wash=True):
        """Render hits with the main kit. A hit can name a route (its 4th item): which kit
        plays it, which key, whether that kit's note map applies, and a level. Its 5th item
        is a choke: seconds until the cymbal is grabbed."""
        import numpy as np
        import sfz

        if self.main is None or self.main not in self.kits:
            raise RuntimeError("No kit is loaded.")
        sr = int(sample_rate)
        self.sample_rate = sr
        preroll = max(0.0, min(preroll, start))
        t0 = start - preroll
        t_end = start + length
        frames = int(round(length * sr))
        out = np.zeros((2, frames), dtype=np.float32)
        valid_ccs = sorted((c for c in (ccs or []) if isinstance(c, (list, tuple)) and len(c) >= 3), key=lambda c: float(c[0]))
        cc_events = []
        last_cc: dict = {}
        for t, c, v in valid_ccs:
            t = float(t)
            if t < t0:
                last_cc[int(c)] = int(v)
            elif t < t_end:
                cc_events.append((t - t0, "cc", int(c), int(v)))
        for c, v in last_cc.items():
            cc_events.append((0.0, "cc", c, v))
        routes = routes if isinstance(routes, list) else []
        groups: dict[str, dict] = {}
        for item in notes or []:
            if not isinstance(item, (list, tuple)) or len(item) < 3:
                continue
            t = float(item[0])
            if not (t0 - 1e-6 <= t < t_end):
                continue
            n, v = int(item[1]), int(item[2])
            route = None
            if len(item) > 3 and item[3] is not None:
                try:
                    idx = int(item[3])
                except (TypeError, ValueError):
                    idx = -1
                if 0 <= idx < len(routes) and isinstance(routes[idx], dict):
                    route = routes[idx]
            choke = _choke_of(item)
            path, key, raw, gain, take = self.main, n, False, 1.0, None
            if route:
                path = os.path.abspath(route.get("path") or self.main)
                key = int(route.get("note", n))
                raw = bool(route.get("raw"))
                gain = max(0.0, float(route.get("gain", 1.0)))
                if route.get("take") is not None:
                    take = max(0, int(route["take"]))
            g = groups.setdefault(path, {"cooked": [], "gains": [], "takes": [], "chokes": [], "raw": [], "route": route})
            if raw:
                g["raw"].append((t, key, v, gain, take, choke))
            else:
                g["cooked"].append([t, key, v])
                g["gains"].append(gain)
                g["takes"].append(take)
                g["chokes"].append(choke)
        skip = int(round(preroll * sr))
        for path, g in groups.items():
            try:
                if path == self.main:
                    entry = self.kits[self.main]
                else:
                    r = g["route"] or {}
                    _, entry = self._open_kit(path, r if ("noteMap" in r or "hihat" in r or "calibrate" in r or "cc" in r) else None)
            except Exception as exc:  # noqa: BLE001  (a missing borrowed kit shouldn't silence the rest)
                print(f"Kit couldn't be used: {path} ({exc})", file=sys.stderr)
                continue
            kit, opts = entry["kit"], entry["opts"]
            events = list(cc_events)
            hits = []
            if g["cooked"]:
                mapped = sfz.apply_kit_rules(g["cooked"], valid_ccs, opts.get("noteMap"), opts.get("hihat"))
                hits += [(t, n, v, gain, take, choke) for (t, n, v), gain, take, choke in zip(mapped, g["gains"], g["takes"], g["chokes"])]
            hits += g["raw"]
            for t, n, v, gain, take, choke in hits:
                events.append((max(0.0, t - t0), "note", int(n), int(v), gain, take))
                if choke and t + choke < t_end:
                    events.append((max(0.0, t + choke - t0), "choke", int(n), 0))
            if not any(e[1] == "note" for e in events):
                continue
            events.sort(key=lambda e: (e[0], {"cc": 0, "note": 1}.get(e[1], 2)))
            seed = (int(round(start * 1000)) + zlib.crc32(path.encode("utf-8"))) & 0x7FFFFFFF
            # The kit's own starting controls (like hi-hat openness), then the mixer's settings.
            controls = {**(opts.get("cc") or {}), **((cc_overrides or {}) if path == self.main else {})}
            audio = kit.render(events, preroll + length, sr, controls or None, seed=seed, variations=variations,
                               wash=self._wash_keys(opts) if wash else None)
            audio *= self._kit_gain(entry, sr)
            part = audio[:, skip: skip + frames]
            out[:, :part.shape[1]] += part
        return np.ascontiguousarray(out, dtype=np.float32)

    # -- rendering ----------------------------------------------------------
    def render(self, notes, ccs, start: float, preroll: float, length: float, sample_rate: int, cc_overrides=None, routes=None,
               variations="cycle", wash=True):
        import numpy as np

        if self.mode == "sfz":
            return self.render_kit(notes, ccs, start, preroll, length, sample_rate, cc_overrides, routes, variations, wash)
        self._need_plugin()
        if int(sample_rate) != self.sample_rate:
            state = self.get_state()
            self.load(self.path, int(sample_rate), state)
        sr = self.sample_rate
        preroll = max(0.0, min(preroll, start))
        t0 = start - preroll
        t_end = start + length
        frames = int(round(length * sr))
        events = build_events(notes, ccs, t0, t_end)
        if not any((m[0] & 0xF0) == 0x90 for _, m in events):
            return np.zeros((2, frames), dtype=np.float32)
        write_midi_file(self.midi_path, events)
        self.proc.load_midi(self.midi_path, clear_previous=True, beats=False, all_events=True)
        total = preroll + length + (self.latency / sr) + 0.01
        self.engine.render(total)
        audio = np.asarray(self.engine.get_audio(), dtype=np.float32)
        if audio.ndim == 1:
            audio = audio[np.newaxis, :]
        if audio.shape[0] == 1:
            audio = np.vstack([audio, audio])
        elif audio.shape[0] > 2:
            audio = audio[:2]
        skip = int(round(preroll * sr)) + self.latency
        out = audio[:, skip: skip + frames]
        if out.shape[1] < frames:
            out = np.pad(out, ((0, 0), (0, frames - out.shape[1])))
        return np.ascontiguousarray(out, dtype=np.float32)


def worker_main(conn) -> None:
    """Entry point of the engine process. Must run on the process main thread."""
    host = Host()

    while True:
        try:
            msg = conn.recv()
        except (EOFError, OSError):
            break
        cmd = msg.get("cmd")
        if cmd == "quit":
            try:
                conn.send({"ok": True})
            except Exception:  # noqa: BLE001
                pass
            break
        started = time.time()
        try:
            if cmd == "ping":
                reply = {"ok": True}
            elif cmd == "load":
                info = host.load(msg["path"], msg["sampleRate"], msg.get("state"))
                reply = {"ok": True, **info}
            elif cmd == "load_kit":
                info = host.load_kit(msg["path"], msg["sampleRate"], msg.get("options"))
                reply = {"ok": True, **info}
            elif cmd == "takes":
                info = host.take_count(msg["path"], msg.get("options"), int(msg["note"]), bool(msg.get("raw")))
                reply = {"ok": True, **info}
            elif cmd == "describe_kit":
                info = host.describe_kit(msg["path"], msg.get("sampleRate") or 48000, msg.get("options"), msg.get("preload"))
                reply = {"ok": True, **info}
            elif cmd == "unload":
                host.unload()
                reply = {"ok": True}
            elif cmd == "get_state":
                reply = {"ok": True, "state": host.get_state()}
            elif cmd == "set_state":
                host.set_state(msg["state"])
                reply = {"ok": True}
            elif cmd == "editor":
                reply = {"ok": True, "state": host.open_editor()}
            elif cmd == "render":
                audio = host.render(
                    msg.get("notes", []),
                    msg.get("ccs", []),
                    float(msg["start"]),
                    float(msg.get("preroll", 0.0)),
                    float(msg["length"]),
                    int(msg["sampleRate"]),
                    msg.get("cc"),
                    msg.get("routes"),
                    msg.get("variations") or "cycle",
                    msg.get("wash", True) is not False,
                )
                reply = {
                    "ok": True,
                    "frames": int(audio.shape[1]),
                    "channels": 2,
                    "sampleRate": host.sample_rate,
                    "pcm": audio.tobytes(),
                }
            else:
                reply = {"ok": False, "error": f"Unknown engine command: {cmd}"}
        except Exception as exc:  # noqa: BLE001
            reply = {"ok": False, "error": str(exc) or exc.__class__.__name__, "trace": traceback.format_exc()}
        reply["ms"] = int((time.time() - started) * 1000)
        try:
            conn.send(reply)
        except (EOFError, OSError):
            break
    sys.exit(0)
