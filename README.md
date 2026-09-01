# Wplace Pixel Analyzer

A high-performance, collaborative pixel art analyzer and leaderboard scanner for [wplace.live](https://wplace.live). Efficiently tallies pixel ownership across custom rectangular regions using visual tile diffing, multi-tiered cloud caching, and dynamic rate-limit auto-tuning.

---

## Features

* **Visual Tile Diffing Engine:** Pre-fetches raw 1000×1000 sector PNGs and compares color byte arrays in memory. If a pixel hasn't changed appearance, the cached painter is resolved instantly with **0 API requests**.
* **Three-Tier Architecture:**
    * **L1 (Local IndexedDB):** Instant local cache persisting across sessions.
    * **L2 (Shared Cloudflare D1 Cache):** Community-driven shared database that pulls and pushes discoveries in bulk per sector.
    * **L3 (Official Wplace API):** Fallback live queries executed only for newly modified or unknown pixels.


* **Passive Click Harvesting:** Intercepts routine in-game pixel inspections and saves painter details to local and cloud caches in the background with zero added rate-limit overhead.
* **Adaptive Rate Limiting & Target Cadence:**
    * Auto-adjusts query delay based on response times and error codes.
    * Automatically learns the network floor, handles `429 Too Many Requests` pauses, and steps speed back up during consecutive success streaks.


* **Real-Time EMA ETA Tracker:** Uses an Exponential Moving Average to calculate accurate completion estimates.
* **Interactive UI:** Movable, draggable panel with 2-click canvas boundary selection.

---

## Installation

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. Click **[here](https://raw.githubusercontent.com/dinisafonsopinto/Wplace-Pixel-Analyzer/main/content.user.js)** to install the userscript.
3. Open or refresh [wplace.live](https://wplace.live). The control panel will appear in the top-left corner.

---

## How to Use

1. **Select an Area:**
* Click **Select Area** and click two opposite corners of your target rectangle directly on the canvas, **or**
* Manually enter the start and end coordinates into the **Start X/Y** and **End X/Y** input fields.


2. **Configure Scan Mode:**
* **Tile Diffing (Recommended):** Compares tile images to skip queries for static pixels.
* **Cloud Sync:** Synchronizes discoveries with the shared Cloudflare D1 database.


3. **Run Analysis:**
* Click **Start Analysis**. The script will diff the area, query any missing pixels, and render a final breakdown of contributors sorted by pixel count.



---

## Technical Configuration

| Setting | Default | Description |
| --- | --- | --- |
| **Target Interval** | `800 ms` | Ideal delay cycle between consecutive live API requests. |
| **Min Floor** | `600 ms` | Dynamic lower bound the auto-tuner will not cross. |
| **429 Pause** | `65 s` | Cool-off duration when hitting rate limits. |
| **429 Penalty** | `+100 ms` | Added pacing delay following a rate-limit event. |
| **Speed Step** | `-10 ms` | Acceleration step deducted after sustained success streaks. |
| **Streak for Step** | `30` | Successful requests required to speed up by one step. |

---

## Notes & Disclaimer

* Use this script responsibly. Setting request intervals too low can trigger temporary IP rate limits from official endpoints.
* Use this userscript at your own risk. The author is not responsible for any potential consequences resulting from its usage.