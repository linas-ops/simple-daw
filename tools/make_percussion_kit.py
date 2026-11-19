"""Builds the Simple DAW Percussion kit from VCSL samples.

The samples come from the Versilian Community Sample Library (CC0):
https://github.com/sgossner/VCSL

Run it with a local copy of VCSL that has at least the files listed below:

    python tools/make_percussion_kit.py path/to/VCSL

It writes app/kitdefs/percussion/Simple DAW Percussion.sfz and kit.json.
Every layer is level-matched so loudness follows velocity smoothly, the
silence before each hit is trimmed, and muted strokes stop open ones.
"""
from __future__ import annotations

import json
import math
import os
import sys

import numpy as np
import soundfile as sf

VCSL_COMMIT = "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "..", "app", "kitdefs", "percussion")

CAJ = "Idiophones/Struck Idiophones/Cajon/"
BON = "Membranophones/Struck Membranophones/Bongos/"
CON = "Membranophones/Struck Membranophones/Conga/"
DAR = "Membranophones/Struck Membranophones/Darbuka/"
FRM = "Membranophones/Struck Membranophones/Frame Drum/"
BDR = "Membranophones/Struck Membranophones/Bass Drum 1/"
SLT = "Idiophones/Struck Idiophones/Slit Drum/"
AGO = "Idiophones/Struck Idiophones/Agogo Bells/"
COW = "Idiophones/Struck Idiophones/Cowbells/"
SHS = "Idiophones/Struck Idiophones/Shaker, Small/"
SHL = "Idiophones/Struck Idiophones/Shaker, Large/"
TB1 = "Idiophones/Struck Idiophones/Tambourine 1/"
TB2 = "Idiophones/Struck Idiophones/Tambourine 2/"
TRI = "Idiophones/Struck Idiophones/Triangles/"
CLV = "Idiophones/Struck Idiophones/Claves/"
GUI = "Idiophones/Struck Idiophones/Guiro/"
CAB = "Idiophones/Struck Idiophones/Cabasa/"
WDB = "Idiophones/Struck Idiophones/Woodblock/"
CLP = "Idiophones/Struck Idiophones/Claps/"
VIB = "Idiophones/Struck Idiophones/Vibraslap/Legacy/"
BTR = "Idiophones/Struck Idiophones/Bell Tree/Stroke/"
SLB = "Idiophones/Struck Idiophones/Sleigh Bells/"


def rr(prefix: str, stem: str, layers: list[str], rrs=("rr1", "rr2"), suffix: str = "") -> list[list[str]]:
    """[[layer1 rr files], [layer2 rr files], ...] for names like Stem_v1_rr1_Mid.wav."""
    out = []
    for v in layers:
        out.append([f"{prefix}{stem}_{v}_{r}{suffix}.wav" for r in rrs])
    return out


# Loudness of the hardest hit, before the kit's overall level is set.
TARGET = {"drum": 0.9, "clap": 0.7, "bell": 0.6, "shaker": 0.45, "shimmer": 0.38}
# Random tuning in cents (+/-) and random level in dB, so repeats never match exactly.
RANDOM = {"drum": (8, 1.5), "clap": (12, 1.5), "bell": (4, 1.2), "shaker": (14, 2.0), "shimmer": (3, 1.0)}

# key, name, family shown in Simple DAW, sound class, pan (-100 left .. 100 right), layers (soft to loud)
SOUNDS = [
    # ---- General MIDI percussion keys ----
    dict(key=39, name="Hand clap", family="Shakers and claps", cls="clap", pan=0,
         layers=[[f"{CLP}Clap_rr{i}.wav" for i in range(1, 7)]]),
    dict(key=54, name="Tambourine", family="Shakers and claps", cls="shaker", pan=30,
         layers=[[f"{TB1}Tamb1_Hit_v1_rr1_Mid.wav", f"{TB2}Tamb2_Hit_v1_rr1_Mid.wav"],
                 [f"{TB1}Tamb1_Hit_v2_rr1_Mid.wav", f"{TB2}Tamb2_Hit_v2_rr2_Mid.wav"]]),
    dict(key=56, name="Cowbell", family="Bells and wood", cls="bell", pan=15,
         layers=rr(COW, "Cowbell1_Hit", ["v2", "v3", "v4"], rrs=("rr1",), suffix="_Mid")),
    dict(key=58, name="Vibraslap", family="Bells and wood", cls="shimmer", pan=-25, poly=2,
         layers=[[f"{VIB}vibraslap_rr{i}.wav" for i in range(1, 5)]]),
    dict(key=60, name="Bongo high", family="Hand drums", cls="drum", pan=-20, group=60, off_by=93,
         layers=rr(BON, "BongoH_Hit1", ["v1", "v2", "v3"], suffix="_Mid")),
    dict(key=61, name="Bongo low", family="Hand drums", cls="drum", pan=-12, group=61, off_by=94,
         layers=rr(BON, "BongoL_Hit1", ["v1", "v2", "v3"], suffix="_Mid")),
    dict(key=62, name="Quinto (muted)", family="Hand drums", cls="drum", pan=12, group=62,
         layers=rr(CON, "Quinto_HitFM1", ["v1", "v2"], suffix="_Sum")),
    dict(key=63, name="Quinto (open)", family="Hand drums", cls="drum", pan=12, group=63, off_by=62,
         layers=rr(CON, "Quinto_HitN", ["v1", "v2", "v3"], suffix="_Sum")),
    dict(key=64, name="Conga (open)", family="Hand drums", cls="drum", pan=22, group=64, off_by=92,
         layers=rr(CON, "Conga_HitN", ["v1", "v2", "v3"], suffix="_Sum")),
    dict(key=67, name="Agogô high", family="Bells and wood", cls="bell", pan=-15,
         layers=rr(AGO, "Agogo_High", ["v1", "v2", "v3"], rrs=("rr1",), suffix="_Mid")),
    dict(key=68, name="Agogô low", family="Bells and wood", cls="bell", pan=-15,
         layers=rr(AGO, "Agogo_Low", ["v1", "v2"], rrs=("rr1",), suffix="_Mid")),
    dict(key=69, name="Cabasa", family="Shakers and claps", cls="shaker", pan=20,
         layers=[[f"{CAB}Cabasa1_Hit_rr1_Mid.wav", f"{CAB}Cabasa1_Hit_rr2_Mid.wav"]]),
    dict(key=70, name="Maracas", family="Shakers and claps", cls="shaker", pan=-30,
         layers=[[f"{SHL}LShaker_Hit_rr1_Mid.wav", f"{SHL}LShaker_Hit_rr2_Mid.wav"]]),
    dict(key=73, name="Guiro (short)", family="Shakers and claps", cls="shaker", pan=25,
         layers=[[f"{GUI}Guiro_Hit_rr1_Mid.wav", f"{GUI}Guiro_Hit_rr2_Mid.wav"]]),
    dict(key=74, name="Guiro (long)", family="Shakers and claps", cls="shaker", pan=25, poly=2,
         layers=[[f"{GUI}Guiro_Med_rr1_Mid.wav", f"{GUI}Guiro_Fast_rr1_Mid.wav"]]),
    dict(key=75, name="Claves", family="Bells and wood", cls="bell", pan=-8,
         layers=[[f"{CLV}Claves1_Hit_{v}_rr1_Mid.wav", f"{CLV}Claves2_Hit_{v}_rr1_Mid.wav"] for v in ("v1", "v2", "v3")]),
    dict(key=76, name="Wood block high", family="Bells and wood", cls="bell", pan=10,
         layers=[[f"{WDB}wood_click_pp_rr1.wav", f"{WDB}wood_click_pp_rr2.wav", f"{WDB}wood_click_pp_rr3.wav"],
                 [f"{WDB}wood_click_mp.wav", f"{WDB}wood_click3_vl1.wav"],
                 [f"{WDB}wood_click_f_rr1.wav", f"{WDB}wood_click_f_rr2.wav"],
                 [f"{WDB}wood_click_ff.wav", f"{WDB}wood_click3_vl2.wav"]]),
    dict(key=77, name="Wood block low", family="Bells and wood", cls="bell", pan=10, transpose=-5,
         layers=[[f"{WDB}wood_click_pp_rr1.wav", f"{WDB}wood_click_pp_rr2.wav", f"{WDB}wood_click_pp_rr3.wav"],
                 [f"{WDB}wood_click_mp.wav", f"{WDB}wood_click3_vl1.wav"],
                 [f"{WDB}wood_click_f_rr1.wav", f"{WDB}wood_click_f_rr2.wav"],
                 [f"{WDB}wood_click_ff.wav", f"{WDB}wood_click3_vl2.wav"]]),
    dict(key=80, name="Triangle (muted)", family="Bells and wood", cls="shimmer", pan=35, group=80,
         layers=rr(TRI, "Triangle3_HitM", ["v1", "v2"], suffix="_Mid")),
    dict(key=81, name="Triangle (open)", family="Bells and wood", cls="shimmer", pan=35, group=81, off_by=80, poly=4,
         layers=rr(TRI, "Triangle3_Hit", ["v1", "v2"], suffix="_Mid")),
    dict(key=82, name="Shaker", family="Shakers and claps", cls="shaker", pan=-30,
         seq=[[f"{SHS}Mid_ShakerHighFaster_Down_rr1.wav", f"{SHS}Mid_ShakerHighFaster_Down_rr2.wav"],
              [f"{SHS}Mid_ShakerHighFaster_Up_rr1.wav", f"{SHS}Mid_ShakerHighFaster_Up_rr2.wav"]]),
    dict(key=83, name="Sleigh bells", family="Shakers and claps", cls="shaker", pan=30, poly=4,
         layers=[[f"{SLB}Sleighbells_Hit_rr1_Mid.wav", f"{SLB}Sleighbells_Hit_rr2_Mid.wav"]]),
    dict(key=84, name="Bell tree", family="Bells and wood", cls="shimmer", pan=40, poly=3,
         layers=[[f"{BTR}BellTree_Stroke_{i}_Mid.wav" for i in (3, 4, 6)]]),
    dict(key=87, name="Concert bass drum", family="Hand drums", cls="drum", pan=0, poly=3,
         layers=rr(BDR, "BDrumNew_hit", ["v2", "v3", "v5", "v7"], suffix="_Sum")),
    # ---- extra sounds (not part of General MIDI) ----
    dict(key=88, name="Cajón bass", family="Hand drums", cls="drum", pan=0,
         layers=[[f"{CAJ}Cajon_hit2_pp_rr1.wav", f"{CAJ}Cajon_hit2_pp_rr2.wav"],
                 [f"{CAJ}Cajon_hit3_p_rr1.wav", f"{CAJ}Cajon_hit3_p_rr2.wav"],
                 [f"{CAJ}Cajon_hit3_mp_rr1.wav", f"{CAJ}Cajon_hit3_mp_rr2.wav"],
                 [f"{CAJ}Cajon_hit3_f_rr1.wav", f"{CAJ}Cajon_hit3_f_rr2.wav"]]),
    dict(key=89, name="Cajón slap", family="Hand drums", cls="drum", pan=0,
         layers=[[f"{CAJ}Cajon_hit1_{v}_rr1.wav", f"{CAJ}Cajon_hit1_{v}_rr2.wav"] for v in ("mp", "f", "fff")]),
    dict(key=90, name="Tumba (open)", family="Hand drums", cls="drum", pan=30, group=90, off_by=91,
         layers=[[f"{CON}Tumba_HitN_v1_rr2_Sum.wav"]] + rr(CON, "Tumba_HitN", ["v2", "v3", "v4"], suffix="_Sum")),
    dict(key=91, name="Tumba (muted)", family="Hand drums", cls="drum", pan=30, group=91,
         layers=rr(CON, "Tumba_HitFM", ["v2", "v3", "v4"], suffix="_Sum")),
    dict(key=92, name="Conga (muted)", family="Hand drums", cls="drum", pan=22, group=92,
         layers=rr(CON, "Conga_HitFM", ["v1", "v2"], suffix="_Sum")),
    dict(key=93, name="Bongo high (muted)", family="Hand drums", cls="drum", pan=-20, group=93,
         layers=rr(BON, "BongoH_HitMuted1", ["v1", "v2", "v3"], suffix="_Mid")),
    dict(key=94, name="Bongo low (muted)", family="Hand drums", cls="drum", pan=-12, group=94,
         layers=rr(BON, "BongoL_HitMuted2", ["v1", "v2", "v3"], suffix="_Mid")),
    dict(key=95, name="Cowbell (muted)", family="Bells and wood", cls="bell", pan=15,
         layers=rr(COW, "Cowbell1_Muted", ["v2", "v3"], rrs=("rr1",), suffix="_Mid")),
    dict(key=96, name="Tambourine shake", family="Shakers and claps", cls="shaker", pan=30,
         layers=[[f"{TB1}Tamb1_Shake_rr1_Mid.wav", f"{TB1}Tamb1_Shake_rr2_Mid.wav",
                  f"{TB2}Tamb2_Shake_rr3_Mid.wav", f"{TB2}Tamb2_Shake_rr4_Mid.wav"]]),
    dict(key=97, name="Darbuka doum", family="Hand drums", cls="drum", pan=-5,
         layers=[[f"{DAR}Darbuka_1_hit_{v}_rr1.wav", f"{DAR}Darbuka_1_hit_{v}_rr2.wav"] for v in ("vl1", "vl2")]),
    dict(key=98, name="Darbuka tek", family="Hand drums", cls="drum", pan=-5,
         layers=[[f"{DAR}Darbuka_2_hit_{v}_rr1.wav", f"{DAR}Darbuka_2_hit_{v}_rr2.wav"] for v in ("vl1", "vl2")]),
    dict(key=99, name="Darbuka ka", family="Hand drums", cls="drum", pan=-5,
         layers=[[f"{DAR}Darbuka_3_hit_{v}_rr1.wav", f"{DAR}Darbuka_3_hit_{v}_rr2.wav"] for v in ("vl1", "vl2")]),
    dict(key=100, name="Frame drum", family="Hand drums", cls="drum", pan=0, poly=3,
         layers=rr(FRM, "HDrumL_Hit", ["v2", "v3"], suffix="_Sum")),
    dict(key=101, name="Frame drum (muted)", family="Hand drums", cls="drum", pan=0,
         layers=rr(FRM, "HDrumL_HitMuted", ["v2", "v3"], suffix="_Sum")),
    dict(key=102, name="Log drum high", family="Hand drums", cls="drum", pan=-10,
         layers=rr(SLT, "LogDrumHi_MedM", ["v1", "v2", "v3"], rrs=("rr1",), suffix="_Sum")),
    dict(key=103, name="Log drum low", family="Hand drums", cls="drum", pan=10,
         layers=rr(SLT, "LogDrumLo_MedM", ["v1", "v2", "v3"], rrs=("rr1",), suffix="_Sum")),
]

# What each pad of an electronic kit plays when Percussion is the whole kit.
PADS = {
    36: 88, 35: 88,          # kick -> cajón bass
    38: 89, 40: 89,          # snare and rim -> cajón slap
    37: 75,                  # cross-stick -> claves
    48: 60, 50: 60,          # tom 1 / high tom -> bongo high
    45: 61, 47: 61,          # tom 2 -> bongo low
    43: 64,                  # tom 3 -> conga
    41: 90,                  # tom 4 -> tumba
    42: 82, 44: 82,          # hi-hat closed and pedal -> shaker
    46: 54,                  # hi-hat open -> tambourine
    51: 56,                  # ride -> cowbell
    53: 67, 59: 68,          # ride bell and edge -> agogô
    49: 81, 55: 80,          # crash -> triangle, splash -> muted triangle
    57: 84,                  # crash 2 -> bell tree
    52: 83,                  # china -> sleigh bells
}

# The order sounds are listed in Simple DAW's sound picker.
DISPLAY_ORDER = [
    88, 89, 60, 61, 93, 94, 63, 62, 64, 92, 90, 91, 97, 98, 99, 100, 101, 102, 103, 87,  # hand drums
    82, 70, 69, 54, 96, 83, 73, 74, 39,                                                  # shakers and claps
    56, 95, 67, 68, 75, 76, 77, 81, 80, 84, 58,                                          # bells and wood
]

SPLITS = {1: [(1, 127)], 2: [(1, 80), (81, 127)], 3: [(1, 50), (51, 95), (96, 127)], 4: [(1, 40), (41, 72), (73, 100), (101, 127)]}


def measure(path: str) -> dict:
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    mono = np.abs(data).max(axis=1)
    peak = float(mono.max())
    onset = int(np.argmax(mono > 0.1 * peak)) if peak > 0 else 0
    return {"peak": peak, "onset": onset, "sr": sr, "bytes": os.path.getsize(path)}


def db(x: float) -> float:
    return 20.0 * math.log10(max(x, 1e-9))


def main(vcsl_root: str) -> None:
    info: dict[str, dict] = {}
    lines = [
        "// Simple DAW Percussion",
        "// Samples: Versilian Community Sample Library (VCSL) by Versilian Studios LLC, CC0 1.0.",
        "// https://github.com/sgossner/VCSL",
        "// Mapping by Simple DAW (made by tools/make_percussion_kit.py). Public domain (CC0 1.0).",
        "",
        "<control>",
        "default_path=VCSL/",
        "",
        "<global>",
        "amp_veltrack=85",
        "",
    ]

    def region_lines(sound: dict, files: list[str], lo: int, hi: int, seq: tuple | None = None) -> list[str]:
        cls = sound["cls"]
        target = TARGET[cls]
        peaks = [info[f]["peak"] for f in files]
        mean = sum(peaks) / len(peaks)
        out = []
        n = len(files)
        for i, f in enumerate(files):
            m = info[f]
            # Level-match the layer, and keep half of the natural difference between its round robins.
            vol = db(target / mean) + 0.5 * db(mean / m["peak"])
            offset = max(0, m["onset"] - int(0.0015 * m["sr"]))
            parts = [f"lovel={lo}", f"hivel={hi}"]
            if seq:
                parts += [f"seq_length={seq[0]}", f"seq_position={seq[1]}"]
                if n > 1:
                    parts += [f"lorand={i / n:.4f}", f"hirand={(i + 1) / n:.4f}"]
            elif n == 2:
                parts += ["seq_length=2", f"seq_position={i + 1}"]
            elif n > 2:
                parts += [f"lorand={i / n:.4f}", f"hirand={(i + 1) / n:.4f}"]
            parts += [f"volume={vol:.2f}"]
            if offset:
                parts.append(f"offset={offset}")
            parts.append(f"sample={f}")
            out.append("<region> " + " ".join(parts))
        return out

    for s in SOUNDS:
        files = [f for layer in s.get("layers", []) for f in layer] + [f for seq in s.get("seq", []) for f in seq]
        for f in files:
            if f not in info:
                full = os.path.join(vcsl_root, f)
                if not os.path.exists(full):
                    raise SystemExit(f"Missing sample: {f}")
                info[f] = measure(full)
        pitch, amp = RANDOM[s["cls"]]
        group_ops = [f"key={s['key']}", f"pan={s['pan']}", f"pitch_random={pitch}", f"amp_random={amp}"]
        if s.get("group"):
            group_ops.append(f"group={s['group']}")
        if s.get("off_by"):
            group_ops.append(f"off_by={s['off_by']}")
        if s.get("poly"):
            group_ops.append(f"note_polyphony={s['poly']}")
        if s.get("transpose"):
            group_ops.append(f"transpose={s['transpose']}")
        lines.append(f"// {s['name']}")
        lines.append(f"<group> group_label={s['name']}")
        lines.append(" ".join(group_ops))
        if "seq" in s:
            # Alternate strokes (down, up, down, up...), each picked at random from its takes.
            seqs = s["seq"]
            for pos, takes in enumerate(seqs, start=1):
                lines.extend(region_lines(s, takes, 1, 127, seq=(len(seqs), pos)))
        else:
            layers = s["layers"]
            for (lo, hi), layer in zip(SPLITS[len(layers)], layers):
                lines.extend(region_lines(s, layer, lo, hi))
        lines.append("")

    os.makedirs(OUT_DIR, exist_ok=True)
    sfz_path = os.path.join(OUT_DIR, "Simple DAW Percussion.sfz")
    with open(sfz_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines))

    by_key = {s["key"]: s for s in SOUNDS}
    labels = {str(k): s["name"] for k, s in by_key.items()}
    for pad, key in PADS.items():
        labels[str(pad)] = by_key[key]["name"]
    files = sorted(info)
    kit = {
        "id": "percussion",
        "name": "Percussion",
        "author": "Versilian Studios (VCSL)",
        "license": "CC0 (public domain)",
        "size": f"{sum(info[f]['bytes'] for f in files) / 1e6:.0f} MB",
        "bytes": sum(info[f]["bytes"] for f in files),
        "desc": "Cajón, congas, bongos, shakers, tambourine, cowbell, agogô, triangle and more. Your pads play it right away, and any lane can use its sounds.",
        "folder": "Percussion",
        "source": {
            "type": "files",
            "base": f"https://raw.githubusercontent.com/sgossner/VCSL/{VCSL_COMMIT}/",
            "into": "VCSL",
            "files": [[f, info[f]["bytes"]] for f in files],
            "copy": ["Simple DAW Percussion.sfz"],
        },
        "manifest": {
            "name": "Percussion",
            "author": "Versilian Studios (VCSL)",
            "license": "CC0 (public domain)",
            "role": "percussion",
            "programs": [
                {"name": "Percussion", "file": "Simple DAW Percussion.sfz",
                 "desc": "Hand percussion on your pads: cajón, bongos, congas, shaker, tambourine, cowbell."},
            ],
            "noteMap": {str(k): v for k, v in PADS.items()},
            "labels": labels,
            "calibrate": {"keys": [89, 63], "target": 0.5},
            "sounds": [{"key": k, "name": by_key[k]["name"], "family": by_key[k]["family"]} for k in DISPLAY_ORDER],
        },
    }
    with open(os.path.join(OUT_DIR, "kit.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(kit, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    print(f"{len(SOUNDS)} sounds, {len(files)} samples, {kit['size']} -> {sfz_path}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
