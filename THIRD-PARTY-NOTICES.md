# Third-party notices

Simple DAW itself is licensed under the GNU General Public License v3.0 (see `LICENSE`).
It includes or downloads the following works, each under its own license.

## Included in this repository

**AVL Drumkits** (the built-in Black Pearl and Red Zeppelin kits)
- By Glen MacArthur, http://www.bandshed.net/avldrumkits/
- License: Creative Commons Attribution-ShareAlike 3.0 Unported (CC BY-SA 3.0)
- Files: `app/kits/avl/samples` (converted to FLAC) and `app/kits/avl/kits.json`
- Full license text: `app/kits/avl/LICENSE.txt`

**Barlow and Barlow Condensed** typefaces
- Copyright 2017 The Barlow Project Authors (https://github.com/jpt/barlow)
- License: SIL Open Font License 1.1 (`app/web/fonts/OFL-Barlow.txt`)

**Saira Stencil One** typeface
- Copyright 2019 The Saira Stencil Project Authors (https://github.com/Omnibus-Type/Saira)
- License: SIL Open Font License 1.1 (`app/web/fonts/OFL-Saira-Stencil.txt`)

## Downloaded only when you ask for them (Sound › Get more kits…)

These are not part of this repository. Simple DAW downloads them from GitHub into your `Kits` folder.

| Kit | By | License | Source |
| --- | --- | --- | --- |
| Percussion | Versilian Studios (VCSL samples); mapping by Simple DAW | CC0 1.0 | https://github.com/sgossner/VCSL |
| Naked Drums | Wilkinson Audio | CC BY 4.0 | https://github.com/sfzinstruments/WilkinsonAudio.NakedDrums |
| Muldjord Kit | DrumGizmo team (Lars Muldjord), SFZ by kinwie | CC BY 4.0 | https://github.com/sfzinstruments/DrumGizmo.MuldjordKit |
| DRS Kit | DrumGizmo team and DRSDrums, SFZ by kinwie | CC BY 4.0 | https://github.com/sfzinstruments/DrumGizmo.DRSKit |

The Percussion mapping (`app/kitdefs/percussion/Simple DAW Percussion.sfz`) is dedicated to the public domain under CC0 1.0, like the samples it uses.

## Python libraries installed by the launcher

Installed from PyPI into `app/.venv` the first time Simple DAW starts (see `app/requirements.txt`):

- DawDreamer (GPLv3), plugin hosting
- NumPy (BSD 3-Clause)
- python-soundfile (BSD 3-Clause), with libsndfile (LGPL 2.1)
- python-soxr (LGPL 2.1), with libsoxr (LGPL 2.1)
