// ==UserScript==
// @name         Wplace Pixel Rect Analyzer
// @namespace    http://tampermonkey.net/
// @version      3.1
// @description  High-speed scanner backed by a shared Cloudflare D1 SQLite backend, tile diffing, target cadence pacing, and local IndexedDB caching.
// @author       Dinis12481
// @match        *://*.wplace.live/*
// @match        *://wplace.live/*
// @grant        GM.xmlHttpRequest
// @grant        GM_xmlhttpRequest
// @connect      backend.wplace.live
// @connect      files.wplace.live
// @connect      wplace-sync.dinisafonsopinto.workers.dev
// ==/UserScript==

(async function() {
    'use strict';

    // Set your Cloudflare Worker URL here:
    const SHARED_BACKEND_URL = "https://wplace-sync.dinisafonsopinto.workers.dev";

    const TILE_SIZE = 1000;
    let selectionStep = 0;
    let pixelCache = {};
    let db;
    let isScanning = false;

    // --- Web Worker for Unthrottled Background Timers ---
    const workerBlob = new Blob([`
        self.onmessage = function(e) {
            setTimeout(() => self.postMessage('tick'), e.data);
        };
    `], { type: 'application/javascript' });
    const timerWorker = new Worker(URL.createObjectURL(workerBlob));

    const wait = (ms) => new Promise(resolve => {
        if (ms <= 0) return resolve();
        timerWorker.onmessage = () => resolve();
        timerWorker.postMessage(ms);
    });

    // --- IndexedDB Setup ---
    async function initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('WplaceCacheDB', 2);
            request.onupgradeneeded = (e) => {
                db = e.target.result;
                if (!db.objectStoreNames.contains('pixels')) db.createObjectStore('pixels');
            };
            request.onsuccess = (e) => { db = e.target.result; resolve(); };
            request.onerror = (e) => reject(e.target.error);
        });
    }

    async function loadCacheToRAM() {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(['pixels'], 'readonly');
            const store = transaction.objectStore('pixels');
            const request = store.openCursor();
            request.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    const val = cursor.value;
                    pixelCache[cursor.key] = typeof val === 'string' ? { u: val, c: null } : val;
                    cursor.continue();
                } else resolve();
            };
            request.onerror = (e) => reject(e.target.error);
        });
    }

    async function saveBatchToDB(newPixelsMap) {
        if (Object.keys(newPixelsMap).length === 0) return;
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(['pixels'], 'readwrite');
            const store = transaction.objectStore('pixels');
            for (const [key, value] of Object.entries(newPixelsMap)) {
                store.put(value, key);
            }
            transaction.oncomplete = () => resolve();
            transaction.onerror = (e) => reject(e.target.error);
        });
    }

    async function clearDB() {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(['pixels'], 'readwrite');
            const store = transaction.objectStore('pixels');
            const request = store.clear();
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    }

    function formatETA(totalSecs) {
        if (totalSecs <= 0) return "0s";
        const h = Math.floor(totalSecs / 3600);
        const m = Math.floor((totalSecs % 3600) / 60);
        const s = totalSecs % 60;
        if (h > 0) return `${h}h ${m}m ${s}s`;
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
    }

    function getCoords(absX, absY) {
        return {
            tileX: Math.floor(absX / TILE_SIZE),
            tileY: Math.floor(absY / TILE_SIZE),
            pixelX: ((absX % TILE_SIZE) + TILE_SIZE) % TILE_SIZE,
            pixelY: ((absY % TILE_SIZE) + TILE_SIZE) % TILE_SIZE
        };
    }

    // --- Cloudflare Shared Backend API Calls ---
    function fetchBackendTile(tileX, tileY) {
        return new Promise((resolve) => {
            if (!SHARED_BACKEND_URL || SHARED_BACKEND_URL.includes("YOUR-WORKER-SUBDOMAIN")) return resolve({});
            const gmXhr = typeof GM !== 'undefined' && GM.xmlHttpRequest ? GM.xmlHttpRequest : GM_xmlhttpRequest;
            gmXhr({
                method: "GET",
                url: `${SHARED_BACKEND_URL}/tile/${tileX}/${tileY}`,
                headers: { "Accept": "application/json" },
                onload: (response) => {
                    if (response.status === 200) {
                        try { resolve(JSON.parse(response.responseText)); } catch (e) { resolve({}); }
                    } else resolve({});
                },
                onerror: () => resolve({}),
                ontimeout: () => resolve({})
            });
        });
    }

    function syncBackendTile(tileX, tileY, batchMap) {
        return new Promise((resolve) => {
            if (!SHARED_BACKEND_URL || SHARED_BACKEND_URL.includes("YOUR-WORKER-SUBDOMAIN") || Object.keys(batchMap).length === 0) {
                return resolve();
            }
            const gmXhr = typeof GM !== 'undefined' && GM.xmlHttpRequest ? GM.xmlHttpRequest : GM_xmlhttpRequest;
            gmXhr({
                method: "POST",
                url: `${SHARED_BACKEND_URL}/tile/${tileX}/${tileY}`,
                headers: { "Content-Type": "application/json" },
                data: JSON.stringify(batchMap),
                onload: () => resolve(),
                onerror: () => resolve(),
                ontimeout: () => resolve()
            });
        });
    }

    // --- Tile Image Fetching & Pixel Extraction ---
    function fetchTileImageData(tileX, tileY) {
        const url = `https://backend.wplace.live/files/s0/tiles/${tileX}/${tileY}.png`;
        return new Promise((resolve, reject) => {
            const gmXhr = typeof GM !== 'undefined' && GM.xmlHttpRequest ? GM.xmlHttpRequest : GM_xmlhttpRequest;
            gmXhr({
                method: "GET",
                url: url,
                responseType: "blob",
                onload: async (response) => {
                    if (response.status === 200) {
                        try {
                            const blob = response.response;
                            const imgBitmap = await createImageBitmap(blob);
                            const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
                            const ctx = canvas.getContext('2d');
                            ctx.drawImage(imgBitmap, 0, 0);
                            const imgData = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
                            resolve(imgData.data);
                        } catch (err) {
                            reject(err);
                        }
                    } else reject(new Error(`Tile HTTP ${response.status}`));
                },
                onerror: () => reject(new Error("Tile Network Error")),
                ontimeout: () => reject(new Error("Tile Timeout"))
            });
        });
    }

    function getTilePixelColor(tileData, pixelX, pixelY) {
        const idx = (pixelY * TILE_SIZE + pixelX) * 4;
        const r = tileData[idx];
        const g = tileData[idx + 1];
        const b = tileData[idx + 2];
        const a = tileData[idx + 3];
        if (a === 0) return -1;
        return (r << 16) | (g << 8) | b;
    }

    function fetchPixelData(tileX, tileY, pixelX, pixelY) {
        const url = `https://backend.wplace.live/s0/pixel/${tileX}/${tileY}?x=${pixelX}&y=${pixelY}`;
        return new Promise((resolve) => {
            const gmXhr = typeof GM !== 'undefined' && GM.xmlHttpRequest ? GM.xmlHttpRequest : GM_xmlhttpRequest;
            gmXhr({
                method: "GET",
                url: url,
                headers: { "Accept": "application/json" },
                onload: (response) => {
                    if (response.status === 200) {
                        try {
                            resolve({ success: true, data: JSON.parse(response.responseText) });
                        } catch (e) {
                            resolve({ success: false, status: 200, error: "JSON parse error" });
                        }
                    } else {
                        resolve({ success: false, status: response.status });
                    }
                },
                onerror: () => resolve({ success: false, status: 0, error: "Network error" }),
                ontimeout: () => resolve({ success: false, status: 408, error: "Timeout" })
            });
        });
    }

    // --- Passive Click Harvesting ---
    const hookScript = document.createElement('script');
    hookScript.textContent = `(${function() {
        const origFetch = window.fetch;
        window.fetch = async (...args) => {
            const response = await origFetch(...args);
            try {
                const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) ? args[0].url : '';
                if (url.includes('/pixel/')) {
                    const match = url.match(/\/pixel\/(-?\d+)\/(-?\d+)\?x=(\d+)&y=(\d+)/);
                    if (match) {
                        const globalX = (parseInt(match[1], 10) * 1000) + parseInt(match[3], 10);
                        const globalY = (parseInt(match[2], 10) * 1000) + parseInt(match[4], 10);
                        window.dispatchEvent(new CustomEvent('wp-pixel-clicked', { detail: { x: globalX, y: globalY } }));

                        const clone = response.clone();
                        clone.json().then(data => {
                            const username = data?.paintedBy?.name || "Blank / Unknown";
                            window.dispatchEvent(new CustomEvent('wp-pixel-harvested', {
                                detail: { x: globalX, y: globalY, tileX: parseInt(match[1], 10), tileY: parseInt(match[2], 10), pixelX: parseInt(match[3], 10), pixelY: parseInt(match[4], 10), username: username }
                            }));
                        }).catch(() => {});
                    }
                }
            } catch(e) {}
            return response;
        };
    }.toString()})();`;
    document.documentElement.appendChild(hookScript);
    hookScript.remove();

    window.addEventListener('wp-pixel-clicked', (e) => {
        if (selectionStep > 0) handleCanvasClick(e.detail.x, e.detail.y);
    });

    window.addEventListener('wp-pixel-harvested', async (e) => {
        const { x, y, tileX, tileY, pixelX, pixelY, username } = e.detail;
        const cacheKey = `${x}_${y}`;
        const localKey = `${pixelX}_${pixelY}`;
        const existing = pixelCache[cacheKey];

        const record = { u: username, c: existing ? existing.c : null };
        pixelCache[cacheKey] = record;

        if (db) {
            await saveBatchToDB({ [cacheKey]: record });
            const clearBtn = document.getElementById('wp-clear-cache');
            if (clearBtn) clearBtn.textContent = `Clear Cache (${Object.keys(pixelCache).length})`;
        }

        // Fire-and-forget push to shared backend
        syncBackendTile(tileX, tileY, { [localKey]: record });
    });

    function handleCanvasClick(x, y) {
        const statusDiv = document.getElementById('wp-status');
        if (selectionStep === 1) {
            document.getElementById('wp-startx').value = x;
            document.getElementById('wp-starty').value = y;
            selectionStep = 2;
            statusDiv.innerHTML = `<span style="color: #55ff55">Corner 1 set at (${x}, ${y}).</span><br>Click opposite corner...`;
        } else if (selectionStep === 2) {
            document.getElementById('wp-endx').value = x;
            document.getElementById('wp-endy').value = y;
            selectionStep = 0;
            statusDiv.innerHTML = `<span style="color: #55ff55">Area selected!</span><br>Ready to analyze.`;
            document.getElementById('wp-select-btn').style.backgroundColor = '#ddd';
            document.getElementById('wp-select-btn').textContent = 'Select Area';
        }
    }

// --- UI Setup ---
    const panel = document.createElement('div');
    Object.assign(panel.style, {
        position: 'fixed', top: '10px', left: '10px', backgroundColor: 'rgba(20, 20, 20, 0.95)',
        color: '#fff', padding: '10px', borderRadius: '8px', zIndex: '999999',
        fontFamily: 'monospace', fontSize: '11px', border: '1px solid #444',
        boxShadow: '0 4px 10px rgba(0,0,0,0.5)', width: '250px', maxWidth: 'calc(100vw - 20px)',
        boxSizing: 'border-box'
    });

    panel.innerHTML = `
    <div id="pixel-analyzer-drag-handle" style="cursor: grab; user-select: none; background: #333; padding: 4px 8px; margin: -10px -10px 8px -10px; display: flex; justify-content: space-between; align-items: center; border-top-left-radius: 8px; border-top-right-radius: 8px;">
        <span style="font-weight: bold; font-size: 11px;">Wplace Rect Analyzer</span>
        <button id="wp-toggle-btn" style="background: none; border: none; color: #fff; cursor: pointer; font-size: 14px; font-weight: bold; padding: 0 4px; line-height: 1;">−</button>
    </div>

    <div id="wp-panel-content">
        <button id="wp-select-btn" style="width: 100%; padding: 5px; margin-bottom: 6px; cursor: pointer; color: black; background: #ddd; border: none; border-radius: 4px; font-size: 11px;" disabled>Loading Cache...</button>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-bottom: 6px;">
            <input type="number" id="wp-startx" placeholder="Start X" style="width: 100%; padding: 3px; box-sizing: border-box; font-size: 11px;">
            <input type="number" id="wp-starty" placeholder="Start Y" style="width: 100%; padding: 3px; box-sizing: border-box; font-size: 11px;">
            <input type="number" id="wp-endx" placeholder="End X" style="width: 100%; padding: 3px; box-sizing: border-box; font-size: 11px;">
            <input type="number" id="wp-endy" placeholder="End Y" style="width: 100%; padding: 3px; box-sizing: border-box; font-size: 11px;">
        </div>

        <details style="background: rgba(255,255,255,0.05); padding: 6px; border-radius: 4px; margin-bottom: 6px;">
            <summary style="font-weight: bold; color: #aaa; font-size: 10px; cursor: pointer; user-select: none;">Cadence & Auto-Tuning</summary>

            <div style="display: flex; justify-content: space-between; align-items: center; margin: 4px 0 2px 0;">
                <span>Interval (ms):</span>
                <input type="number" id="wp-delay" value="800" min="0" step="25" style="width: 60px; padding: 2px; font-size: 10px;">
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;">
                <span>Min Floor (ms):</span>
                <input type="number" id="wp-min-floor" value="600" min="0" step="25" style="width: 60px; padding: 2px; font-size: 10px;">
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;">
                <span>429 Pause (s):</span>
                <input type="number" id="wp-pause-sec" value="65" min="1" step="5" style="width: 60px; padding: 2px; font-size: 10px;">
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;">
                <span>429 Penalty (ms):</span>
                <input type="number" id="wp-penalty-ms" value="100" min="0" step="25" style="width: 60px; padding: 2px; font-size: 10px;">
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;">
                <span>Speed Step (ms):</span>
                <input type="number" id="wp-step-down" value="10" min="0" step="5" style="width: 60px; padding: 2px; font-size: 10px;">
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <span>Streak for Step:</span>
                <input type="number" id="wp-streak-reqs" value="30" min="1" step="1" style="width: 60px; padding: 2px; font-size: 10px;">
            </div>
        </details>

        <div style="margin-bottom: 6px; font-size: 10px;">
            <label style="cursor: pointer; display: block; margin-bottom: 2px;"><input type="checkbox" id="wp-use-diff" checked> <b>Tile Diffing</b></label>
            <label style="cursor: pointer; display: block;"><input type="checkbox" id="wp-use-cloud" checked> <b>Cloud Sync</b></label>
            <button id="wp-clear-cache" style="margin-top: 4px; padding: 3px 6px; background: #555; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 10px;" disabled>Clear Cache</button>
        </div>

        <button id="wp-analyze-btn" style="width: 100%; padding: 6px; cursor: pointer; border: none; border-radius: 4px; font-size: 11px; font-weight: bold;" disabled>Start Analysis</button>
        <div id="wp-status" style="margin-top: 6px; max-height: 120px; overflow-y: auto; color: #aaa; font-size: 10px;">Initializing DB...</div>
    </div>
    `;
    document.body.appendChild(panel);

    // Minimize / Expand Handler
    const toggleBtn = document.getElementById('wp-toggle-btn');
    const panelContent = document.getElementById('wp-panel-content');
    toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isHidden = panelContent.style.display === 'none';
        panelContent.style.display = isHidden ? 'block' : 'none';
        toggleBtn.textContent = isHidden ? '−' : '+';
        panel.style.width = isHidden ? '250px' : 'auto';
    });

    try {
        await initDB();
        await loadCacheToRAM();
        document.getElementById('wp-clear-cache').textContent = `Clear Cache (${Object.keys(pixelCache).length})`;
        document.getElementById('wp-select-btn').textContent = 'Select Area';
        document.getElementById('wp-select-btn').disabled = false;
        document.getElementById('wp-analyze-btn').disabled = false;
        document.getElementById('wp-clear-cache').disabled = false;
        document.getElementById('wp-status').textContent = 'Ready.';
    } catch (e) {
        document.getElementById('wp-status').innerHTML = `<span style='color:red'>Failed to init Database.</span>`;
    }

    document.getElementById('wp-clear-cache').addEventListener('click', async (e) => {
        if (confirm("Are you sure you want to clear the entire pixel cache?")) {
            await clearDB();
            pixelCache = {};
            e.target.textContent = `Clear Cache (0)`;
        }
    });

    document.getElementById('wp-select-btn').addEventListener('click', (e) => {
        if (isScanning) return;
        if (selectionStep === 0) {
            selectionStep = 1;
            e.target.style.backgroundColor = '#ffffaa';
            e.target.textContent = 'Cancel Selection';
            document.getElementById('wp-status').innerHTML = "Click the <b>first corner</b> of your rectangle in-game...";
        } else {
            selectionStep = 0;
            e.target.style.backgroundColor = '';
            e.target.textContent = 'Select Area';
            document.getElementById('wp-status').innerHTML = "Selection cancelled.";
        }
    });

    // --- Main Scan Logic with Cloud Sync & Tile Diffing ---
    document.getElementById('wp-analyze-btn').addEventListener('click', async (e) => {
        const btn = e.target;
        const statusDiv = document.getElementById('wp-status');

        if (isScanning) {
            isScanning = false;
            btn.textContent = 'Stopping...';
            btn.style.backgroundColor = '#ffaaaa';
            return;
        }

        const useDiff = document.getElementById('wp-use-diff').checked;
        const useCloud = document.getElementById('wp-use-cloud').checked;
        const startX = parseInt(document.getElementById('wp-startx').value, 10);
        const startY = parseInt(document.getElementById('wp-starty').value, 10);
        const endX = parseInt(document.getElementById('wp-endx').value, 10);
        const endY = parseInt(document.getElementById('wp-endy').value, 10);

        if (isNaN(startX) || isNaN(startY) || isNaN(endX) || isNaN(endY)) {
            statusDiv.innerHTML = "<span style='color: #ff5555'>Error: Need coordinates!</span>";
            return;
        }

        let targetInterval = Math.max(0, parseInt(document.getElementById('wp-delay').value, 10) || 0);
        let minFloorInterval = Math.max(0, parseInt(document.getElementById('wp-min-floor').value, 10) || 0);
        const pauseSec = Math.max(1, parseInt(document.getElementById('wp-pause-sec').value, 10) || 65);
        const penaltyMs = Math.max(0, parseInt(document.getElementById('wp-penalty-ms').value, 10) || 0);
        const stepDownMs = Math.max(0, parseInt(document.getElementById('wp-step-down').value, 10) || 0);
        const streakReqs = Math.max(1, parseInt(document.getElementById('wp-streak-reqs').value, 10) || 30);

        const minX = Math.min(startX, endX);
        const maxX = Math.max(startX, endX);
        const minY = Math.min(startY, endY);
        const maxY = Math.max(startY, endY);
        const totalPixels = (maxX - minX + 1) * (maxY - minY + 1);

        isScanning = true;
        btn.textContent = 'Stop Analysis';
        btn.style.backgroundColor = '#ffaaaa';
        document.getElementById('wp-select-btn').disabled = true;

        const counts = {};
        let newPixelsToSave = {};
        const tileDataMap = new Map();

        const minTileX = Math.floor(minX / TILE_SIZE);
        const maxTileX = Math.floor(maxX / TILE_SIZE);
        const minTileY = Math.floor(minY / TILE_SIZE);
        const maxTileY = Math.floor(maxY / TILE_SIZE);

        const intersectingTiles = [];
        for (let ty = minTileY; ty <= maxTileY; ty++) {
            for (let tx = minTileX; tx <= maxTileX; tx++) {
                intersectingTiles.push({ tx, ty });
            }
        }

        // 1. Ingest from Shared Cloud Backend (R2)
        if (useCloud) {
            statusDiv.innerHTML = `Checking cloud cache for ${intersectingTiles.length} sector(s)...`;
            for (const { tx, ty } of intersectingTiles) {
                if (!isScanning) break;
                const cloudTileData = await fetchBackendTile(tx, ty);
                const localBatch = {};
                for (const [coordKey, val] of Object.entries(cloudTileData)) {
                    const [px, py] = coordKey.split('_').map(Number);
                    const globalKey = `${(tx * TILE_SIZE) + px}_${(ty * TILE_SIZE) + py}`;
                    if (!pixelCache[globalKey]) {
                        pixelCache[globalKey] = val;
                        localBatch[globalKey] = val;
                    }
                }
                if (Object.keys(localBatch).length > 0) {
                    await saveBatchToDB(localBatch);
                    document.getElementById('wp-clear-cache').textContent = `Clear Cache (${Object.keys(pixelCache).length})`;
                }
            }
        }

        // 2. Fetch PNG Tile Images for Visual Diffing
        if (useDiff && isScanning) {
            for (let i = 0; i < intersectingTiles.length; i++) {
                if (!isScanning) break;
                const { tx, ty } = intersectingTiles[i];
                const tileKey = `${tx}_${ty}`;
                try {
                    statusDiv.innerHTML = `Downloading sector (${tx}, ${ty}) [${i + 1}/${intersectingTiles.length}]...`;
                    const imgData = await fetchTileImageData(tx, ty);
                    tileDataMap.set(tileKey, imgData);
                } catch (err) {
                    statusDiv.innerHTML = `<span style='color:orange'>Warning: Tile (${tx}, ${ty}) failed to download.</span>`;
                }
            }
        }

        if (!isScanning) {
            isScanning = false;
            btn.textContent = 'Start Analysis';
            btn.style.backgroundColor = '';
            document.getElementById('wp-select-btn').disabled = false;
            return;
        }

        // 3. Diff Queue Generation
        statusDiv.innerHTML = `Analyzing image diffs...`;
        const fetchTasks = [];
        let instantMatches = 0;

        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
                const cacheKey = `${x}_${y}`;
                const cached = pixelCache[cacheKey];
                const { tileX, tileY, pixelX, pixelY } = getCoords(x, y);
                const tileKey = `${tileX}_${tileY}`;
                const tileData = tileDataMap.get(tileKey);

                let currentColor = null;
                if (tileData) {
                    currentColor = getTilePixelColor(tileData, pixelX, pixelY);
                }

                if (useDiff && cached && cached.c !== null && currentColor !== null && cached.c === currentColor) {
                    counts[cached.u] = (counts[cached.u] || 0) + 1;
                    instantMatches++;
                } else {
                    fetchTasks.push({ x, y, tileX, tileY, pixelX, pixelY, currentColor });
                }
            }
        }

        let processed = instantMatches;
        let uncachedRemaining = fetchTasks.length;
        let fetched = 0;
        let consecutiveSuccesses = 0;

        let estimatedMsPerPixel = Math.max(targetInterval, 250);
        let hasMeasuredFirst = false;

        statusDiv.innerHTML = `Diff complete: <b>${instantMatches}</b> unchanged, <b>${fetchTasks.length}</b> to query.<br>`;

        // 4. Query Only Modified / Missing Pixels
        for (const task of fetchTasks) {
            if (!isScanning) break;

            const { x, y, tileX, tileY, pixelX, pixelY, currentColor } = task;
            const cacheKey = `${x}_${y}`;
            let resolved = false;

            while (!resolved && isScanning) {
                const cycleStartTime = performance.now();
                const res = await fetchPixelData(tileX, tileY, pixelX, pixelY);
                const fetchDuration = performance.now() - cycleStartTime;

                if (res.success) {
                    const username = res.data?.paintedBy?.name || "Blank / Unknown";
                    counts[username] = (counts[username] || 0) + 1;

                    const record = { u: username, c: currentColor };
                    pixelCache[cacheKey] = record;
                    newPixelsToSave[cacheKey] = record;

                    processed++;
                    fetched++;
                    uncachedRemaining--;

                    consecutiveSuccesses++;
                    if (stepDownMs > 0 && consecutiveSuccesses >= streakReqs && targetInterval > minFloorInterval) {
                        targetInterval = Math.max(minFloorInterval, targetInterval - stepDownMs);
                        document.getElementById('wp-delay').value = targetInterval;
                        consecutiveSuccesses = 0;
                    }

                    // Save local DB batch
                    if (Object.keys(newPixelsToSave).length >= 50) {
                        await saveBatchToDB(newPixelsToSave);
                        newPixelsToSave = {};
                        document.getElementById('wp-clear-cache').textContent = `Clear Cache (${Object.keys(pixelCache).length})`;
                    }

                    resolved = true;

                    const remainingSleep = Math.max(0, targetInterval - fetchDuration);
                    if (fetchTasks.length > 0 && isScanning && remainingSleep > 0) {
                        await wait(remainingSleep);
                    }

                    const actualCycleDuration = performance.now() - cycleStartTime;

                    if (!hasMeasuredFirst) {
                        estimatedMsPerPixel = actualCycleDuration;
                        hasMeasuredFirst = true;
                    } else {
                        estimatedMsPerPixel = (estimatedMsPerPixel * 0.95) + (actualCycleDuration * 0.05);
                    }

                    const pct = ((processed / totalPixels) * 100).toFixed(1);
                    const etaStr = formatETA(Math.round((uncachedRemaining * estimatedMsPerPixel) / 1000));

                    statusDiv.innerHTML = `[${processed}/${totalPixels} • <span style="color:#55ff55">${pct}%</span>]<br>` +
                                          `Target: <b>${targetInterval}ms</b> (Floor: <b>${minFloorInterval}ms</b>)<br>` +
                                          `Avg: <b>${Math.round(estimatedMsPerPixel)}ms</b> • ETA: <b>${etaStr}</b><br>` +
                                          `Scanned: ${username}`;

                } else if (res.status === 429) {
                    consecutiveSuccesses = 0;

                    const learnedFloor = targetInterval + Math.max(10, stepDownMs);
                    if (learnedFloor > minFloorInterval) {
                        minFloorInterval = learnedFloor;
                        document.getElementById('wp-min-floor').value = minFloorInterval;
                    }

                    targetInterval += penaltyMs;
                    document.getElementById('wp-delay').value = targetInterval;

                    statusDiv.innerHTML = `<span style="color:#ffcc00"><b>Rate Limited (429)!</b></span><br>` +
                                          `Floor: <b>${minFloorInterval}ms</b><br>` +
                                          `Pausing ${pauseSec}s... Target: <b>${targetInterval}ms</b>`;
                    await wait(pauseSec * 1000);
                } else {
                    statusDiv.innerHTML = `<span style="color:#ff5555">Error ${res.status || 'Network'}. Retrying in 2s...</span>`;
                    await wait(2000);
                }
            }
        }

        // 5. Final Save & Sync Back to Cloud Backend
        if (Object.keys(newPixelsToSave).length > 0) {
            statusDiv.innerHTML = `Saving final batch to local cache...`;
            await saveBatchToDB(newPixelsToSave);
            document.getElementById('wp-clear-cache').textContent = `Clear Cache (${Object.keys(pixelCache).length})`;
        }

        if (useCloud && fetchTasks.length > 0) {
            statusDiv.innerHTML = `Syncing discoveries to cloud...`;
            const cloudSyncBuckets = {};
            for (const task of fetchTasks) {
                const { x, y, tileX, tileY, pixelX, pixelY, currentColor } = task;
                const cached = pixelCache[`${x}_${y}`];
                if (cached) {
                    const sectorKey = `${tileX}_${tileY}`;
                    if (!cloudSyncBuckets[sectorKey]) cloudSyncBuckets[sectorKey] = { tx: tileX, ty: tileY, data: {} };
                    cloudSyncBuckets[sectorKey].data[`${pixelX}_${pixelY}`] = cached;
                }
            }

            for (const bucket of Object.values(cloudSyncBuckets)) {
                await syncBackendTile(bucket.tx, bucket.ty, bucket.data);
            }
        }

        let finalHtml = `<strong style="color: #fff">Analysis ${isScanning ? 'Complete' : 'Stopped'}!</strong><br>` +
                        `<span style="color:#aaa; font-size:10px;">Instant: ${instantMatches} | Fetched: ${fetched}</span><br><br>`;
        const sortedCounts = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        for (const [user, count] of sortedCounts) {
            finalHtml += `${user}: <span style="color: #55ff55">${count}</span> px<br>`;
        }

        statusDiv.innerHTML = finalHtml;
        isScanning = false;
        btn.textContent = 'Start Analysis';
        btn.style.backgroundColor = '';
        document.getElementById('wp-select-btn').disabled = false;
    });

    // --- Drag Handle Functionality (Mouse + Touch) ---
    function dragElement(elmnt, handle) {
        let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;

        handle.addEventListener('mousedown', dragStart);
        handle.addEventListener('touchstart', dragStart, { passive: false });

        function dragStart(e) {
            if (e.target.id === 'wp-toggle-btn') return;
            const touch = e.type === 'touchstart' ? e.touches[0] : e;
            pos3 = touch.clientX;
            pos4 = touch.clientY;

            if (e.type === 'touchstart') {
                document.addEventListener('touchend', dragEnd);
                document.addEventListener('touchmove', elementDrag, { passive: false });
            } else {
                document.addEventListener('mouseup', dragEnd);
                document.addEventListener('mousemove', elementDrag);
            }
        }

        function elementDrag(e) {
            e.preventDefault();
            const touch = e.type === 'touchmove' ? e.touches[0] : e;
            pos1 = pos3 - touch.clientX;
            pos2 = pos4 - touch.clientY;
            pos3 = touch.clientX;
            pos4 = touch.clientY;
            elmnt.style.top = Math.max(0, (elmnt.offsetTop - pos2)) + "px";
            elmnt.style.left = Math.max(0, (elmnt.offsetLeft - pos1)) + "px";
        }

        function dragEnd() {
            document.removeEventListener('mouseup', dragEnd);
            document.removeEventListener('mousemove', elementDrag);
            document.removeEventListener('touchend', dragEnd);
            document.removeEventListener('touchmove', elementDrag);
        }
    }
    dragElement(panel, document.getElementById('pixel-analyzer-drag-handle'));
})();