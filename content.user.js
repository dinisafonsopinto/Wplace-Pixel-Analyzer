// ==UserScript==
// @name         Wplace Pixel Rect Analyzer
// @namespace    http://tampermonkey.net/
// @version      5.1
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
    let secretKey = loadSetting('sync-token', '');

    const TILE_SIZE = 1000; // 1000x1000 pixels
    let selectionStep = 0;
    let pixelCache = {};
    let db;
    let isScanning = false;
    let polygonVertices = [];

    let localUsername = "Local User";
    let localUserUid = null;
    let localUserAid = null;
    let localUserAn = null;

    function fetchLocalUserInfo() {
        const gmXhr = typeof GM !== 'undefined' && GM.xmlHttpRequest ? GM.xmlHttpRequest : GM_xmlhttpRequest;
        gmXhr({
            method: "GET",
            url: "https://backend.wplace.live/me",
            headers: { "Accept": "application/json" },
            onload: (response) => {
                if (response.status === 200) {
                    try {
                        const data = JSON.parse(response.responseText);
                        if (data && data.name) {
                            localUsername = data.name;
                            localUserUid = data.id || null;
                            localUserAid = data.allianceId || null;
                            localUserAn = data.allianceName || null;
                        }
                    } catch (e) {}
                }
            }
        });
    }

    let midScanHarvested = new Set();
    const harvestedTileData = new Map();

    // --- Web Worker for Unthrottled Background Timers (Concurrent Safe) ---
    const workerBlob = new Blob([`
        self.onmessage = function(e) {
            setTimeout(() => self.postMessage(e.data.id), e.data.ms);
        };
    `], { type: 'application/javascript' });
    const timerWorker = new Worker(URL.createObjectURL(workerBlob));

    let waitIdCounter = 0;
    const pendingWaits = new Map();

    timerWorker.onmessage = (e) => {
        const resolveCb = pendingWaits.get(e.data);
        if (resolveCb) {
            resolveCb();
            pendingWaits.delete(e.data);
        }
    };

    const wait = (ms) => new Promise(resolve => {
        if (ms <= 0) return resolve();
        const id = ++waitIdCounter;
        pendingWaits.set(id, resolve);
        timerWorker.postMessage({ id, ms });
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

    // --- LocalStorage Persistence Helpers ---
    function saveSetting(key, value) {
        try { localStorage.setItem(`wp-analyzer-${key}`, value); } catch (e) {}
    }

    function loadSetting(key, fallback) {
        try {
            const val = localStorage.getItem(`wp-analyzer-${key}`);
            console.log(`Loaded setting ${key}: ${val}`);
            return val !== null ? val : fallback;
        } catch (e) {
            return fallback;
        }
    }

    const loadBool = (key, defaultBool) => {
        const val = loadSetting(key, defaultBool ? 'true' : 'false');
        return val === 'true' || val === 'on'; // 'on' catches the stuck values from the old bug
    };

    let authorIdMap = {};

    function refreshAuthors() {
        if (!SHARED_BACKEND_URL || SHARED_BACKEND_URL.includes("YOUR-WORKER-SUBDOMAIN")) return Promise.resolve();
        return new Promise((resolve) => {
            const gmXhr = typeof GM !== 'undefined' && GM.xmlHttpRequest ? GM.xmlHttpRequest : GM_xmlhttpRequest;
            gmXhr({
                method: "GET",
                url: `${SHARED_BACKEND_URL}/authors`,
                headers: { "Accept": "application/json" },
                onload: (res) => {
                    if (res.status === 200) {
                        try { authorIdMap = JSON.parse(res.responseText); } catch(e) {}
                    }
                    resolve();
                },
                onerror: () => resolve(),
                ontimeout: () => resolve()
            });
        });
    }

    // --- Cloudflare Shared Backend API Calls ---
    function fetchBackendTile(tileX, tileY) {
        return new Promise((resolve) => {
            if (!SHARED_BACKEND_URL || SHARED_BACKEND_URL.includes("YOUR-WORKER-SUBDOMAIN")) return resolve({});

            // Append a timestamp cache-buster to bypass Cloudflare CDN
            const cacheBuster = Date.now();
            const url = `${SHARED_BACKEND_URL}/tile/${tileX}/${tileY}?t=${cacheBuster}`;

            const gmXhr = typeof GM !== 'undefined' && GM.xmlHttpRequest ? GM.xmlHttpRequest : GM_xmlhttpRequest;
            gmXhr({
                method: "GET",
                url: url,
                headers: { 
                    "Accept": "application/json",
                    "Cache-Control": "no-cache" // Extra instruction for local browser cache
                },
                // Inside fetchBackendTile, replace the onload function with this:
                onload: (response) => {
                    if (response.status === 200) {
                        try { 
                            const raw = JSON.parse(response.responseText);
                            const translated = {};
                            for (const [key, val] of Object.entries(raw)) {
                                let u = val.u;
                                if (val.a !== undefined) {
                                    u = authorIdMap[val.a] ? authorIdMap[val.a].n : "Unknown";
                                }
                                translated[key] = { u: u, c: val.c };
                            }
                            resolve(translated);
                        } catch (e) { resolve({}); }
                    } else resolve({});
                },
                onerror: () => resolve({}),
                ontimeout: () => resolve({})
            });
        });
    }


    async function syncBackendTile(tileX, tileY, batchMap) {
        if (!SHARED_BACKEND_URL || SHARED_BACKEND_URL.includes("YOUR-WORKER-SUBDOMAIN") || Object.keys(batchMap).length === 0) {
            return;
        }
    
        const subSectors = {};
        
        // Group local pixels into 100x100 chunks
        for (const [key, record] of Object.entries(batchMap)) {
            const [px, py] = key.split('_').map(Number);
            const subKey = `${Math.floor(px / 100)}_${Math.floor(py / 100)}`;
            
            if (!subSectors[subKey]) subSectors[subKey] = {};
            subSectors[subKey][key] = record;
        }
    
        // Send each chunk sequentially to prevent network limits
        for (const [subKey, chunkData] of Object.entries(subSectors)) {
            await syncBackendTilePortion(tileX, tileY, chunkData);
            await wait(250); // Give D1 time to process the batch
        }
    }
    
    function syncBackendTilePortion(tileX, tileY, chunkData, maxRetries = 3) {
        return new Promise((resolve) => {
            const gmXhr = typeof GM !== 'undefined' && GM.xmlHttpRequest ? GM.xmlHttpRequest : GM_xmlhttpRequest;
            
            const attempt = (currentTry) => {
                gmXhr({
                    method: "POST",
                    url: `${SHARED_BACKEND_URL}/tile/${tileX}/${tileY}`,
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${secretKey}`
                    },
                    data: JSON.stringify(chunkData),
                    onload: (res) => {
                        if (res.status === 401) {
                            console.error(`[Wplace Analyzer] Cloud sync error (${tileX}, ${tileY}) - Unauthorized`);
                            let newKey = prompt('Invalid Sync Key. Please enter a valid key:');
                            if (newKey) {
                                secretKey = newKey;
                                saveSetting('sync-token', newKey);
                                attempt(1); // reset back to attempt 1
                                return;
                            }

                            resolve();
                            return;
                        }
                        if (res.status >= 400) {
                            // If D1 is busy (503) or Rate Limited (429), retry with exponential backoff
                            if ((res.status === 503 || res.status === 429) && currentTry < maxRetries) {
                                console.warn(`[Wplace Analyzer] D1 busy (HTTP ${res.status}). Retrying chunk (${currentTry}/${maxRetries})...`);
                                setTimeout(() => attempt(currentTry + 1), 1000 * currentTry);
                                return;
                            }
                            console.error(`[Wplace Analyzer] Cloud sync error (${tileX}, ${tileY}) - HTTP ${res.status}`);
                        }
                        resolve();
                    },
                    onerror: () => {
                        if (currentTry < maxRetries) {
                            setTimeout(() => attempt(currentTry + 1), 1000 * currentTry);
                            return;
                        }
                        resolve();
                    },
                    ontimeout: () => {
                        if (currentTry < maxRetries) {
                            setTimeout(() => attempt(currentTry + 1), 1000 * currentTry);
                            return;
                        }
                        resolve();
                    }
                });
            };
            
            attempt(1);
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

    // --- Polygon Helpers ---
    function getPolygonBoundingBox(vertices) {
        if (!vertices || vertices.length === 0) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const v of vertices) {
            if (v.x < minX) minX = v.x;
            if (v.x > maxX) maxX = v.x;
            if (v.y < minY) minY = v.y;
            if (v.y > maxY) maxY = v.y;
        }
        return { minX, maxX, minY, maxY };
    }
    
    function isPointInPolygon(x, y, vertices) {
        let inside = false;
        for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
            const xi = vertices[i].x, yi = vertices[i].y;
            const xj = vertices[j].x, yj = vertices[j].y;
            const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }
    
    let visualizerCtx = null;
    let visBox = { minX: 0, minY: 0 };
    let minimapZoom = 1;
    let minimapPanX = 0;
    let minimapPanY = 0;
    let isMinimapActive = true;
    
    function updateMinimapTransform() {
        const cvs = document.getElementById('wp-pixel-visualizer');
        if (cvs) {
            cvs.style.transformOrigin = '0 0';
            cvs.style.transform = `translate(${minimapPanX}px, ${minimapPanY}px) scale(${minimapZoom})`;
        }
    }
    
    function initVisualizer(minX, maxX, minY, maxY) {
        visBox.minX = minX;
        visBox.minY = minY;
        const width = maxX - minX + 1;
        const height = maxY - minY + 1;
        
        // Reset view parameters for a new scan
        minimapZoom = 1;
        minimapPanX = 0;
        minimapPanY = 0;
        isMinimapActive = true;
        
        document.getElementById('wp-minimap-container').style.display = 'block';
        document.getElementById('wp-minimap-toggle').textContent = 'Hide';
        
        const cvs = document.getElementById('wp-pixel-visualizer');
        cvs.width = width;
        cvs.height = height;
        updateMinimapTransform();
        
        visualizerCtx = cvs.getContext('2d', { willReadFrequently: true });
        visualizerCtx.clearRect(0, 0, width, height);
        
        visualizerCtx.fillStyle = 'rgba(255, 255, 255, 0.05)';
        visualizerCtx.fillRect(0, 0, width, height);
    
        // Bind viewport interactions (Zoom & Pan) only once
        const viewport = document.getElementById('wp-minimap-viewport');
        if (!viewport.dataset.bound) {
            viewport.dataset.bound = "true";
    
            let isDragging = false;
            let startX = 0, startY = 0;
    
            viewport.addEventListener('mousedown', (e) => {
                isDragging = true;
                viewport.style.cursor = 'grabbing';
                startX = e.clientX - minimapPanX;
                startY = e.clientY - minimapPanY;
            });
    
            window.addEventListener('mousemove', (e) => {
                if (!isDragging) return;
                minimapPanX = e.clientX - startX;
                minimapPanY = e.clientY - startY;
                updateMinimapTransform();
            });
    
            window.addEventListener('mouseup', () => {
                isDragging = false;
                viewport.style.cursor = 'grab';
            });
    
            viewport.addEventListener('wheel', (e) => {
                e.preventDefault();
            
                const zoomFactor = 1.15;
            
                const rect = viewport.getBoundingClientRect();
                const centerX = rect.width / 2;
                const centerY = rect.height / 2;
            
                const oldZoom = minimapZoom;
            
                if (e.deltaY < 0) {
                    minimapZoom *= zoomFactor;
                } else {
                    minimapZoom /= zoomFactor;
                    if (minimapZoom < 0.1) minimapZoom = 0.1;
                }
            
                // Keep the center of the viewport fixed while zooming
                minimapPanX = centerX - (centerX - minimapPanX) * (minimapZoom / oldZoom);
                minimapPanY = centerY - (centerY - minimapPanY) * (minimapZoom / oldZoom);
            
                updateMinimapTransform();
            }, { passive: false });
    
            // Toggle Hide/Show performance switch
            document.getElementById('wp-minimap-toggle').addEventListener('click', () => {
                isMinimapActive = !isMinimapActive;
                const toggleBtn = document.getElementById('wp-minimap-toggle');
                const cvsElem = document.getElementById('wp-pixel-visualizer');
                if (isMinimapActive) {
                    cvsElem.style.display = 'block';
                    toggleBtn.textContent = 'Hide';
                } else {
                    cvsElem.style.display = 'none'; // Stops rendering updates & hidden from DOM view
                    toggleBtn.textContent = 'Show';
                }
            });
        }
    }
    
    function drawVisualizerPixel(x, y, status) {
        // 0 -> To be fetched (white)
        // 1 -> fetched color (green)
        // 2 -> fetched transparent (pink/purple)
        // 3 -> cached (blue)
        if (!isMinimapActive || !visualizerCtx) return; // Skips updates completely when hidden for performance
        
        const colorMap = {
            0: '#ffffff', // White
            1: '#00ff00', // Green
            2: '#ff00ff', // Pink/Purple
            3: '#0000ff'  // Blue
        };
        
        const color = colorMap[status] || '#ff0000'; // Fallback to red if unknown
        visualizerCtx.fillStyle = color;
        visualizerCtx.fillRect(x - visBox.minX, y - visBox.minY, 1, 1);
    }

    // --- Passive Click Harvesting ---
    async function getHarvestedPixelColor(tileX, tileY, pixelX, pixelY) {
        const tileKey = `${tileX}_${tileY}`;
    
        let tileData = harvestedTileData.get(tileKey);
    
        if (!tileData) {
            try {
                tileData = await fetchTileImageData(tileX, tileY);
                harvestedTileData.set(tileKey, tileData);
            } catch (err) {
                console.warn(`Failed to fetch tile color for (${tileX}, ${tileY})`, err);
                return null;
            }
        }
    
        return getTilePixelColor(tileData, pixelX, pixelY);
    }

    const hookScript = document.createElement('script');
    hookScript.textContent = `(${function() {
        const origFetch = window.fetch;
        window.fetch = async (...args) => {
            const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) ? args[0].url : '';
            const reqOpts = args[1] || {};
            const method = reqOpts.method || 'GET';
            
            // Let the request hit the server first
            const response = await origFetch(...args);
            
            try {
                // 1. Intercept Outbound Paint Requests AFTER they succeed
                if (method === 'POST' && url.includes('/paint') && response.ok) {
                    const payload = JSON.parse(reqOpts.body);
                    if (payload.tiles && Array.isArray(payload.tiles)) {
                        const paintedCoords = [];
                        payload.tiles.forEach(tile => {
                            const tx = tile.x;
                            const ty = tile.y;
                            const pxs = tile.pixels?.x || [];
                            const pys = tile.pixels?.y || [];
                            const colors = tile.pixels?.colors || [];
    
                            for (let i = 0; i < pxs.length; i++) {
                                paintedCoords.push({ 
                                    tileX: tx, tileY: ty, 
                                    pixelX: pxs[i], pixelY: pys[i], 
                                    colorId: colors[i] - 1, // why don't the colors start at 0???
                                });
                            }
                        });
                        // Fire an event containing the batched coordinates
                        window.dispatchEvent(new CustomEvent('wp-pixels-painted', { detail: paintedCoords }));
                    }
                }
                
                // 2. Your Existing Inbound Response Interception (/pixel/...)
                if (url.includes('/pixel/')) {
                    const match = url.match(/\/pixel\/(-?\d+)\/(-?\d+)\?x=(\d+)&y=(\d+)/);
                    if (match) {
                        const globalX = (parseInt(match[1], 10) * 1000) + parseInt(match[3], 10);
                        const globalY = (parseInt(match[2], 10) * 1000) + parseInt(match[4], 10);
                        window.dispatchEvent(new CustomEvent('wp-pixel-clicked', { detail: { x: globalX, y: globalY } }));
    
                        const clone = response.clone();
                        clone.json().then(data => {
                            const username = data?.paintedBy?.name || "Blank / Unknown";
                            const uid = data?.paintedBy?.id || null;
                            const aid = data?.paintedBy?.allianceId || null;
                            const an = data?.paintedBy?.allianceName || null;
                            window.dispatchEvent(new CustomEvent('wp-pixel-harvested', {
                                detail: { 
                                    x: globalX, y: globalY, 
                                    tileX: parseInt(match[1], 10), tileY: parseInt(match[2], 10), 
                                    pixelX: parseInt(match[3], 10), pixelY: parseInt(match[4], 10), 
                                    username: username,
                                    uid: uid,
                                    aid: aid,
                                    an: an
                                }
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

    const PALETTE = {
        // === FREE COLORS (Indices 0 - 30) ===
        '-1': -1,     // transparent
        0: 0x000000,  // Black
        1: 0x3C3C3C,  // Dark Gray
        2: 0x787878,  // Gray
        3: 0xD2D2D2,  // Light Gray
        4: 0xFFFFFF,  // White
        5: 0x600018,  // Deep Red
        6: 0xED1C24,  // Red
        7: 0xFF7F27,  // Orange
        8: 0xF6AA09,  // Gold
        9: 0xF9DD3B,  // Yellow
        10: 0xFFFABC, // Light Yellow
        11: 0x0EB968, // Dark Green
        12: 0x13E67B, // Green
        13: 0x87FF5E, // Light Green
        14: 0x0C816E, // Dark Teal
        15: 0x10AEA6, // Teal
        16: 0x13E1BE, // Light Teal
        17: 0x60F7F2, // Cyan
        18: 0x28509E, // Dark Blue
        19: 0x4093E4, // Blue
        20: 0x6B50F6, // Indigo
        21: 0x99B1FB, // Light Indigo
        22: 0x780C99, // Dark Purple
        23: 0xAA38B9, // Purple
        24: 0xE09FF9, // Light Purple
        25: 0xCB007A, // Dark Pink
        26: 0xEC1F80, // Pink
        27: 0xF38DA9, // Light Pink
        28: 0x684634, // Dark Brown
        29: 0x95682A, // Brown
        30: 0xF8B277, // Beige
    
        // === PREMIUM COLORS (Indices 31 - 62) ===
        31: 0xAAAAAA, // Medium Gray
        32: 0xA50E1E, // Dark Red
        33: 0xFA8072, // Light Red
        34: 0xE45C1A, // Dark Orange
        35: 0x9C8431, // Olive
        36: 0xC5AD31, // Golden Green
        37: 0xE8D45F, // Lemon Green
        38: 0x4A6B3A, // Forest Green
        39: 0x5A944A, // Grass Green
        40: 0x84C573, // Light Green (Sage)
        41: 0x0F799F, // Ocean Blue
        42: 0xBBFAF2, // Light Cyan
        43: 0x7DC7FF, // Light Blue
        44: 0x4D31B8, // Deep Purple
        45: 0x4A4284, // Dark Purple Gray
        46: 0x7A71C4, // Purple Gray
        47: 0xB5AEF1, // Light Slate Blue
        48: 0x9B5249, // Brown Red
        49: 0xD18078, // Rose Gold
        50: 0xFAB6A4, // Peach
        51: 0xDBA463, // Light Brown
        52: 0x7B6352, // Dark Tan
        53: 0x9C846B, // Tan
        54: 0xD6B594, // Light Tan
        55: 0xD18051, // Dark Beige
        56: 0xFFC5A5, // Light Beige
        57: 0x6D643F, // Dark Stone
        58: 0x948C6B, // Stone
        59: 0xCDC59E, // Light Stone
        60: 0x333941, // Dark Slate
        61: 0x6D758D, // Slate
        62: 0xB3B9D1  // Light Slate
    };

    window.addEventListener('wp-pixels-painted', (e) => {
        const paintedCoords = e.detail;
        if (!paintedCoords || paintedCoords.length === 0) return;

        for (const coord of paintedCoords) {
            const { tileX, tileY, pixelX, pixelY, colorId } = coord;
            const globalX = (tileX * 1000) + pixelX;
            const globalY = (tileY * 1000) + pixelY;
            
            const exactColor = PALETTE[colorId];
            if (exactColor === undefined) {
                console.warn(`[Wplace Analyzer] Unknown color ID ${colorId}. Skipping local cache update.`);
                continue; 
            }

            // Instantly inject into the cache pipeline without querying the server!
            window.dispatchEvent(new CustomEvent('wp-pixel-harvested', {
                detail: { 
                    x: globalX, 
                    y: globalY, 
                    tileX: tileX, 
                    tileY: tileY, 
                    pixelX: pixelX, 
                    pixelY: pixelY, 
                    username: localUsername,
                    uid: localUserUid,
                    aid: localUserAid,
                    an: localUserAn,
                    exactColor: exactColor,
                }
            }));
        }
    });

    window.addEventListener('wp-pixel-clicked', (e) => {
        if (selectionStep > 0) handleCanvasClick(e.detail.x, e.detail.y);
    });

    let outboundSyncQueue = {};
    let syncTimeout = null;

    window.addEventListener('wp-pixel-harvested', async (e) => {
        const { x, y, tileX, tileY, pixelX, pixelY, username, uid, aid, an, exactColor } = e.detail;
        const cacheKey = `${x}_${y}`;
        const localKey = `${pixelX}_${pixelY}`;
        const existing = pixelCache[cacheKey];
    
        // FIX: Only exit early if both the username AND the exact color match
        if (existing && existing.u === username && existing.c !== null) {
            if (exactColor === undefined || existing.c === exactColor) return;
        }
    
        const color = exactColor ?? existing?.c ?? await getHarvestedPixelColor(tileX, tileY, pixelX, pixelY);
        const record = { u: username, uid: uid, aid: aid, an: an, c: color };
        pixelCache[cacheKey] = record;
    
        if (db) {
            saveBatchToDB({ [cacheKey]: record }); // Fire-and-forget
            const clearBtn = document.getElementById('wp-clear-cache');
            if (clearBtn) clearBtn.textContent = `Clear Cache (${Object.keys(pixelCache).length})`;
        }
    
        if (isScanning) midScanHarvested.add(cacheKey);
    
        // FIX: Queue the outbound syncs to prevent Cloudflare D1 database locking
        const sectorKey = `${tileX}_${tileY}`;
        if (!outboundSyncQueue[sectorKey]) {
            outboundSyncQueue[sectorKey] = { tx: tileX, ty: tileY, data: {} };
        }
        outboundSyncQueue[sectorKey].data[localKey] = record;
    
        clearTimeout(syncTimeout);
        syncTimeout = setTimeout(async () => {
            // Copy the queue and reset it immediately to catch new incoming clicks
            const buckets = Object.values(outboundSyncQueue);
            outboundSyncQueue = {}; 
        
            // Await each bucket to prevent concurrent D1 database locks
            for (const bucket of buckets) {
                await syncBackendTile(bucket.tx, bucket.ty, bucket.data);
            }
        }, 5000);
    });

    function drawPolygonSVG(vertices, isClosed = false) {
        let svg = document.getElementById('wp-svg-overlay');
        if (!svg) {
            svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.id = 'wp-svg-overlay';
            Object.assign(svg.style, {
                pointerEvents: 'none', position: 'absolute', top: '0', left: '0',
                width: '100%', height: '100%', zIndex: '9999', overflow: 'visible'
            });
            const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
            polyline.id = 'wp-svg-polyline';
            polyline.setAttribute('stroke', '#00ff00');
            polyline.setAttribute('stroke-width', '2');
            polyline.setAttribute('fill', 'rgba(0, 255, 0, 0.2)');
            svg.appendChild(polyline);
            document.body.appendChild(svg);
        }
        
        const polyline = document.getElementById('wp-svg-polyline');
        let pointsString = vertices.map(v => `${v.x},${v.y}`).join(' ');
        if (isClosed && vertices.length >= 3) pointsString += ` ${vertices[0].x},${vertices[0].y}`;
        polyline.setAttribute('points', pointsString);
    
        // Clear old vertices and redraw
        svg.querySelectorAll('.wp-vertex-circle').forEach(c => c.remove());
        vertices.forEach(v => {
            const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            circle.setAttribute('class', 'wp-vertex-circle');
            circle.setAttribute('cx', v.x);
            circle.setAttribute('cy', v.y);
            circle.setAttribute('r', '4');
            circle.setAttribute('fill', '#ffffff');
            circle.setAttribute('stroke', '#00ff00');
            circle.setAttribute('stroke-width', '2');
            svg.appendChild(circle);
        });
    }

    function handleCanvasClick(x, y) {
        if (selectionStep === 1) {
            polygonVertices.push({ x, y });
            saveSetting('polygon-vertices', JSON.stringify(polygonVertices));
            document.getElementById('wp-vertices-display').textContent = `Vertices: ${polygonVertices.length}`;
            document.getElementById('wp-status').innerHTML = `<span style="color: #55ff55">Vertex added at (${x}, ${y}).</span>`;
            
            drawPolygonSVG(polygonVertices);
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
        <div style="display: flex; gap: 4px; margin-bottom: 6px;">
            <button id="wp-select-btn" style="flex: 1; padding: 5px; cursor: pointer; color: black; background: #ddd; border: none; border-radius: 4px; font-size: 11px;" disabled>Loading Cache...</button>
            <button id="wp-close-btn" style="flex: 1; padding: 5px; cursor: pointer; color: black; background: #ddd; border: none; border-radius: 4px; font-size: 11px;" disabled>Close Shape</button>
        </div>
        <div id="wp-vertices-display" style="text-align: center; font-size: 11px; margin-bottom: 6px;">Vertices: 0</div>

        <details style="background: rgba(255,255,255,0.05); padding: 6px; border-radius: 4px; margin-bottom: 6px;">
            <summary style="font-weight: bold; color: #aaa; font-size: 10px; cursor: pointer; user-select: none;">Cadence & Auto-Tuning</summary>

            <div style="display: flex; justify-content: space-between; align-items: center; margin: 4px 0 2px 0;">
                <span>Interval (ms):</span>
                <input type="number" id="wp-delay" min="0" step="25" style="width: 60px; padding: 2px; font-size: 10px;">
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;">
                <span>Min Floor (ms):</span>
                <input type="number" id="wp-min-floor" min="0" step="25" style="width: 60px; padding: 2px; font-size: 10px;">
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;">
                <span>429 Pause (s):</span>
                <input type="number" id="wp-pause-sec" min="1" step="5" style="width: 60px; padding: 2px; font-size: 10px;">
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;">
                <span>429 Penalty (ms):</span>
                <input type="number" id="wp-penalty-ms" min="0" step="25" style="width: 60px; padding: 2px; font-size: 10px;">
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;">
                <span>Speed Step (ms):</span>
                <input type="number" id="wp-step-down" min="0" step="5" style="width: 60px; padding: 2px; font-size: 10px;">
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <span>Streak for Step:</span>
                <input type="number" id="wp-streak-reqs" min="1" step="1" style="width: 60px; padding: 2px; font-size: 10px;">
            </div>
        </details>

        <div style="margin-bottom: 6px; font-size: 10px;">
            <label style="cursor: pointer; display: block; margin-bottom: 2px;"><input type="checkbox" id="wp-use-diff" checked> <b>Tile Diffing</b></label>
            <label style="cursor: pointer; display: block; margin-bottom: 2px;"><input type="checkbox" id="wp-use-cloud-download" checked> <b>Cloud Sync (Download)</b></label>
            <label style="cursor: pointer; display: block; margin-bottom: 2px;"><input type="checkbox" id="wp-use-cloud-upload"> <b>Cloud Sync (Upload)</b></label>
            <label style="cursor: pointer; display: block;"><input type="checkbox" id="wp-use-expand"> <b>Auto-Expand (Current Tiles)</b></label>
            <button id="wp-clear-cache" style="margin-top: 4px; padding: 3px 6px; background: #555; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 10px;" disabled>Clear Cache</button>
        </div>

        <div id="wp-minimap-container" style="display:none; margin-bottom: 6px; padding: 4px; border: 1px solid #444; border-radius: 4px; background: rgba(0,0,0,0.3);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; font-size: 9px; color: #aaa;">
                <span>Minimap (Scroll to Zoom, Drag to Pan)</span>
                <button id="wp-minimap-toggle" style="background: #444; border: none; color: white; font-size: 9px; cursor: pointer; padding: 1px 4px; border-radius: 2px;">Hide</button>
            </div>
            <div id="wp-minimap-viewport" style="width: 100%; height: 150px; overflow: hidden; position: relative; cursor: grab; background: #111; border-radius: 2px;">
                <canvas id="wp-pixel-visualizer" style="position: absolute; top: 0; left: 0; image-rendering: pixelated; transform-origin: 0 0; padding-left: 0; padding-right: 0; margin-left: auto; margin-right: auto; display: block; width: 100%;"></canvas>
            </div>
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
        fetchLocalUserInfo();
        refreshAuthors();

        // --- UI Setup ---
        document.getElementById('wp-clear-cache').textContent = `Clear Cache (${Object.keys(pixelCache).length})`;
        document.getElementById('wp-select-btn').textContent = 'Select Area';
        document.getElementById('wp-select-btn').disabled = false;
        document.getElementById('wp-analyze-btn').disabled = false;
        document.getElementById('wp-clear-cache').disabled = false;
        document.getElementById('wp-status').textContent = 'Ready.';

        // --- Load Cached Vertices ---
        try {
            const savedStr = loadSetting('polygon-vertices', '[]');
            const parsed = JSON.parse(savedStr);
            if (Array.isArray(parsed) && parsed.length > 0) {
                polygonVertices = parsed;
                document.getElementById('wp-vertices-display').textContent = `Vertices: ${polygonVertices.length}`;
                
                const isClosed = polygonVertices.length >= 3;
                drawPolygonSVG(polygonVertices, isClosed);
                
                if (isClosed) {
                    document.getElementById('wp-analyze-btn').disabled = false;
                    document.getElementById('wp-status').innerHTML = `<span style="color: #55ff55">Loaded closed shape!</span> Ready to analyze.`;
                }
            }
        } catch(e) {
            polygonVertices = [];
        }

        document.getElementById('wp-delay').value = loadSetting('delay', '800');
        document.getElementById('wp-min-floor').value = loadSetting('min-floor', '600');
        document.getElementById('wp-pause-sec').value = loadSetting('pause-sec', '65');
        document.getElementById('wp-penalty-ms').value = loadSetting('penalty-ms', '100');
        document.getElementById('wp-step-down').value = loadSetting('step-down', '10');
        document.getElementById('wp-streak-reqs').value = loadSetting('streak-reqs', '30');
        document.getElementById('wp-use-cloud-upload').checked = loadBool('use-cloud-upload', false);
        document.getElementById('wp-use-cloud-download').checked = loadBool('use-cloud-download', true);
        document.getElementById('wp-use-diff').checked = loadBool('use-diff', true);
        document.getElementById('wp-use-expand').checked = loadBool('use-expand', false);

        // --- Save Inputs Automatically on Change ---
        const inputIds = ['wp-delay', 'wp-min-floor', 'wp-pause-sec', 'wp-penalty-ms', 'wp-step-down', 'wp-streak-reqs', 'wp-use-diff', 'wp-use-expand'];

        inputIds.forEach(id => {
            const el = document.getElementById(id);
            const eventType = el.type === 'checkbox' ? 'change' : 'input';
            
            el.addEventListener(eventType, () => {
                // Force explicit "true" or "false" strings for checkboxes
                const val = el.type === 'checkbox' ? (el.checked ? 'true' : 'false') : el.value;
                saveSetting(id.replace('wp-', ''), val);
            });
        });
        // custom for cloud upload (must also have download checked)
        document.getElementById('wp-use-cloud-upload').addEventListener('change', () => {
            if (document.getElementById('wp-use-cloud-upload').checked) {
                document.getElementById('wp-use-cloud-download').checked = true;
                saveSetting('use-cloud-download', 'true');
            }
        })
        document.getElementById('wp-use-cloud-download').addEventListener('change', () => {
            if (!document.getElementById('wp-use-cloud-download').checked) {
                document.getElementById('wp-use-cloud-upload').checked = false;
                saveSetting('use-cloud-upload', 'false');
            }
        })
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
        // const existingVis = document.getElementById('wp-pixel-visualizer');
        // if (existingVis) existingVis.remove();
        if (selectionStep === 0) {
            selectionStep = 1;
            polygonVertices = [];
            document.getElementById('wp-vertices-display').textContent = `Vertices: 0`;
            const existingSvg = document.getElementById('wp-svg-overlay');
            if (existingSvg) existingSvg.remove();
            
            e.target.style.backgroundColor = '#ffffaa';
            e.target.textContent = 'Cancel Selection';
            document.getElementById('wp-close-btn').disabled = false;
            document.getElementById('wp-analyze-btn').disabled = true;
            document.getElementById('wp-minimap-container').style.display = 'none';
            document.getElementById('wp-status').innerHTML = "Click points on the canvas to draw a shape...";
        } else {
            selectionStep = 0;
            document.getElementById('wp-minimap-container').style.display = 'none';
            const existingSvg = document.getElementById('wp-svg-overlay');
            if (existingSvg) existingSvg.remove();
            
            e.target.style.backgroundColor = '';
            e.target.textContent = 'Select Area';
            document.getElementById('wp-close-btn').disabled = true;
            document.getElementById('wp-status').innerHTML = "Selection cancelled.";
        }
    });

    document.getElementById('wp-close-btn').addEventListener('click', (e) => {
        if (polygonVertices.length < 3) {
            document.getElementById('wp-status').innerHTML = "<span style='color:#ff5555'>Need at least 3 vertices!</span>";
            return;
        }
        selectionStep = 0;
        
        drawPolygonSVG(polygonVertices, true); // Seal it visually
        
        document.getElementById('wp-select-btn').style.backgroundColor = '';
        document.getElementById('wp-select-btn').textContent = 'Select Area';
        e.target.disabled = true;
        document.getElementById('wp-analyze-btn').disabled = false;
        document.getElementById('wp-status').innerHTML = `<span style="color: #55ff55">Shape closed!</span> Ready to analyze.`;
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

        if (polygonVertices.length < 3) {
            statusDiv.innerHTML = "<span style='color: #ff5555'>Error: No polygon defined!</span>";
            return;
        }

        const useDiff = document.getElementById('wp-use-diff').checked;
        const useCloudDownload = document.getElementById('wp-use-cloud-download').checked;
        const useCloudUpload = document.getElementById('wp-use-cloud-upload').checked;
        const useExpand = document.getElementById('wp-use-expand').checked;

        if (useCloudUpload && !secretKey) {
            statusDiv.innerHTML = "<span style='color: #ff5555'>Error: No sync key defined!</span>";
            let newKey = prompt('Invalid Sync Key. Please enter a valid key:');
            if (newKey) {
                secretKey = newKey;
                saveSetting('sync-token', newKey);
            } else {
                statusDiv.innerHTML = "<span style='color: #ff5555'>Error: No sync key defined! Please disable Cloud Sync.</span>";
                return;
            }
        }

        const visitedPixels = new Set();
        const expansionQueue = [];
        const activeVein = []; // for when a vein of cached pixels is together
        let taskIndex = 0;
        let expansionIndex = 0;

        // Change signature to accept a target array, defaulting to expansionQueue
        function checkNeighbors(px, py, targetQueue = expansionQueue) {
            const neighbors = [
                { nx: px, ny: py - 1 }, // Up
                { nx: px, ny: py + 1 }, // Down
                { nx: px - 1, ny: py }, // Left
                { nx: px + 1, ny: py }, // Right
                { nx: px - 1, ny: py - 1 }, // Up-Left
                { nx: px + 1, ny: py - 1 }, // Up-Right
                { nx: px - 1, ny: py + 1 }, // Down-Left
                { nx: px + 1, ny: py + 1 }, // Down-Right
                // tolerance
                { nx: px - 2, ny: py }, // Left-Left
                { nx: px + 2, ny: py }, // Right-Right
                { nx: px, ny: py - 2 }, // Up-Up
                { nx: px, ny: py + 2 }, // Down-Down

                // randomly generated
                // { nx: px + Math.floor(Math.random() * 10) - 5, ny: py + Math.floor(Math.random() * 10) - 5 },
            ];
            for (const { nx, ny } of neighbors) {
                const key = `${nx}_${ny}`;

                if (visitedPixels.has(key)) {
                    // Soft-promote: Push a duplicate into activeVein if it's part of a mid-scan line
                    if (targetQueue === activeVein && midScanHarvested.has(key)) {
                        const coords = getCoords(nx, ny);
                        activeVein.push({ 
                            x: nx, y: ny, 
                            tileX: coords.tileX, tileY: coords.tileY, 
                            pixelX: coords.pixelX, pixelY: coords.pixelY 
                        });
                    }
                    continue;
                }

                if (isPointInPolygon(nx, ny, polygonVertices)) continue;
                
                const coords = getCoords(nx, ny);
                if (!tileDataMap.has(`${coords.tileX}_${coords.tileY}`)) continue;

                visitedPixels.add(key);
                
                // Push to whatever queue was passed in
                targetQueue.push({ 
                    x: nx, y: ny, 
                    tileX: coords.tileX, tileY: coords.tileY, 
                    pixelX: coords.pixelX, pixelY: coords.pixelY 
                });
                drawVisualizerPixel(nx, ny, 0);
            }
        }
        
        const { minX, maxX, minY, maxY } = getPolygonBoundingBox(polygonVertices);

        const pad = useExpand ? (TILE_SIZE * 2) : 0;
        initVisualizer(minX - pad, maxX + pad, minY - pad, maxY + pad);
        
        let totalPixels = 0;
        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
                if (isPointInPolygon(x, y, polygonVertices)) totalPixels++;
            }
        }

        let targetInterval = Math.max(0, parseInt(document.getElementById('wp-delay').value, 10) || 0);
        let minFloorInterval = Math.max(0, parseInt(document.getElementById('wp-min-floor').value, 10) || 0);
        const pauseSec = Math.max(1, parseInt(document.getElementById('wp-pause-sec').value, 10) || 65);
        const penaltyMs = Math.max(0, parseInt(document.getElementById('wp-penalty-ms').value, 10) || 0);
        const stepDownMs = Math.max(0, parseInt(document.getElementById('wp-step-down').value, 10) || 0);
        const streakReqs = Math.max(1, parseInt(document.getElementById('wp-streak-reqs').value, 10) || 30);

        isScanning = true;
        midScanHarvested.clear();
        btn.textContent = 'Stop Analysis';
        btn.style.backgroundColor = '#ffaaaa';
        document.getElementById('wp-select-btn').disabled = true;

        const counts = {};
        let newPixelsToSave = {};
        let cloudBatchQueue = {};
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

        // 1. Ingest & Reconcile Shared Cloud Backend
        if (useCloudDownload || useCloudUpload) {
            statusDiv.innerHTML = `Syncing cloud cache for ${intersectingTiles.length} sector(s)...`;
            
            await refreshAuthors();
            
            // --- PRE-COMPUTE: Bucket only the relevant local pixels to avoid 1,000,000 grid iterations ---
            const localTiles = {};
            const activeTiles = new Set(intersectingTiles.map(t => `${t.tx}_${t.ty}`));

            for (const [globalKey, record] of Object.entries(pixelCache)) {
                const [gx, gy] = globalKey.split('_').map(Number);
                const tx = Math.floor(gx / TILE_SIZE);
                const ty = Math.floor(gy / TILE_SIZE);
                const tileKey = `${tx}_${ty}`;
                
                if (activeTiles.has(tileKey)) {
                    if (!localTiles[tileKey]) localTiles[tileKey] = {};
                    
                    const px = ((gx % TILE_SIZE) + TILE_SIZE) % TILE_SIZE;
                    const py = ((gy % TILE_SIZE) + TILE_SIZE) % TILE_SIZE;
                    localTiles[tileKey][`${px}_${py}`] = { globalKey, record };
                }
            }

            for (const { tx, ty } of intersectingTiles) {
                if (!isScanning) break;
                const cloudTileData = await fetchBackendTile(tx, ty);
                const localBatch = {};
                const missingFromCloud = {};
                
                const tileKey = `${tx}_${ty}`;
                const localPixelsInTile = localTiles[tileKey] || {};
                
                const baseGlobalX = tx * TILE_SIZE;
                const baseGlobalY = ty * TILE_SIZE;

                // A. Pull new discoveries from Cloud into Local Cache
                for (const [localKey, cloudRecord] of Object.entries(cloudTileData)) {
                    if (!localPixelsInTile[localKey]) {
                        const [px, py] = localKey.split('_').map(Number);
                        const globalKey = `${baseGlobalX + px}_${baseGlobalY + py}`;
                        pixelCache[globalKey] = cloudRecord;
                        localBatch[globalKey] = cloudRecord;
                    }
                }
                
                // Save new cloud items locally
                if (Object.keys(localBatch).length > 0) {
                    await saveBatchToDB(localBatch);
                    document.getElementById('wp-clear-cache').textContent = `Clear Cache (${Object.keys(pixelCache).length})`;
                }

                // B. Find local pixels in this sector that Cloudflare doesn't have yet
                if (useCloudUpload) {
                    for (const [localKey, localData] of Object.entries(localPixelsInTile)) {
                        if (!cloudTileData[localKey]) {
                            missingFromCloud[localKey] = localData.record;
                        }
                    }
                    
                    // Push orphaned local items to Cloudflare
                    if (Object.keys(missingFromCloud).length > 0) {
                        await syncBackendTile(tx, ty, missingFromCloud);
                    }
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
                if (!isPointInPolygon(x, y, polygonVertices)) continue;

                const cacheKey = `${x}_${y}`;
                visitedPixels.add(cacheKey); // Mark core polygon pixels as visited
                
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

                    const isColor = currentColor !== -1 && currentColor !== null;
                    drawVisualizerPixel(x, y, isColor ? 1 : 2);
                    if (useExpand && currentColor !== -1 && currentColor !== null) checkNeighbors(x, y);
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

        const scannedKeys = new Set();

        // 4. Query Only Modified / Missing Pixels
        while ((taskIndex < fetchTasks.length || activeVein.length > 0 || (useExpand && expansionIndex < expansionQueue.length)) && isScanning) {
            let task, isExpansionTask = false;
            
            // Prioritize fetchTasks array, then activeVein. Fall back to expansionQueue.
            if (taskIndex < fetchTasks.length) {
                task = fetchTasks[taskIndex++];
            } else if (activeVein.length > 0) {
                task = activeVein.pop(); 
                isExpansionTask = true;
            } else {
                const remaining = expansionQueue.length - expansionIndex;

                // Adjust this exponent to control the drop-off steepness:
                const skewFactor = 2;
                
                // Math.pow() skews the random number toward 0 (smaller offsets)
                const randOffset = Math.floor(Math.pow(Math.random(), skewFactor) * remaining);
                const targetIdx = expansionIndex + randOffset;
                
                // Swap the random item to our current index position
                const temp = expansionQueue[expansionIndex];
                expansionQueue[expansionIndex] = expansionQueue[targetIdx];
                expansionQueue[targetIdx] = temp;
                
                task = expansionQueue[expansionIndex++];
                isExpansionTask = true;
            }
        
            const { x, y, tileX, tileY, pixelX, pixelY } = task;
            const cacheKey = `${x}_${y}`;

            if (scannedKeys.has(cacheKey)) {
                if (!isExpansionTask) uncachedRemaining--; 
                continue;
            }
            scannedKeys.add(cacheKey);
            
            let currentColor = task.currentColor;
        
            if (midScanHarvested.has(cacheKey)) {
                processed++;
                if (!isExpansionTask) uncachedRemaining--;
                checkNeighbors(x, y, activeVein); // instead of reading it from the cache and wasting more resources, just check the neighbors anyway, since this if block will rarely be hit
                drawVisualizerPixel(x, y, 3);
                continue; 
            }


        
            // Inline Diff Check for discovered Expansion Pixels
            if (isExpansionTask) {
                const cached = pixelCache[cacheKey];
                const tileData = tileDataMap.get(`${tileX}_${tileY}`);
                if (tileData) currentColor = getTilePixelColor(tileData, pixelX, pixelY);
        
                if (useDiff && cached && cached.c !== null && currentColor !== null && cached.c === currentColor) {
                    counts[cached.u] = (counts[cached.u] || 0) + 1;
                    processed++;
                    if (currentColor !== -1 && currentColor !== null) checkNeighbors(x, y, activeVein);

                    drawVisualizerPixel(x, y, 3);
                    continue; 
                }
                uncachedRemaining++; // Flagged for network fetch, add to remaining
            }
        
            let resolved = false;
            while (!resolved && isScanning) {
                const cycleStartTime = performance.now();
                const res = await fetchPixelData(tileX, tileY, pixelX, pixelY);
        
                if (res.success) {
                    const username = res.data?.paintedBy?.name || "Blank / Unknown";
                    counts[username] = (counts[username] || 0) + 1;
        
                    const record = { u: username, c: currentColor };
                    pixelCache[cacheKey] = record;
                    newPixelsToSave[cacheKey] = record;
                    
                    if (useCloudDownload) {
                        const sectorKey = `${tileX}_${tileY}`;
                        if (!cloudBatchQueue[sectorKey]) cloudBatchQueue[sectorKey] = { tx: tileX, ty: tileY, data: {} };
                        cloudBatchQueue[sectorKey].data[`${pixelX}_${pixelY}`] = record;
                    }

                    processed++;
                    fetched++;
                    uncachedRemaining--;

                    const isColor = currentColor !== -1 && currentColor !== null;

                    if (useExpand && isColor) checkNeighbors(x, y);
        
                    consecutiveSuccesses++;
                    if (stepDownMs > 0 && consecutiveSuccesses >= streakReqs && targetInterval > minFloorInterval) {
                        targetInterval = Math.max(minFloorInterval, targetInterval - stepDownMs);
                        document.getElementById('wp-delay').value = targetInterval;
                        consecutiveSuccesses = 0;
                    }
        
                    if (Object.keys(newPixelsToSave).length >= 50) {
                        await saveBatchToDB(newPixelsToSave);
                        newPixelsToSave = {};
                        document.getElementById('wp-clear-cache').textContent = `Clear Cache (${Object.keys(pixelCache).length})`;

                        // Periodic cloud flush so stopping the script never drops progress
                        if (useCloudDownload && Object.keys(cloudBatchQueue).length > 0) {
                            const buckets = Object.values(cloudBatchQueue);
                            cloudBatchQueue = {};
                            for (const bucket of buckets) {
                                await syncBackendTile(bucket.tx, bucket.ty, bucket.data);
                            }
                        }
                    }
        
                    resolved = true;
        
                    const fetchDuration = performance.now() - cycleStartTime;
                    const remainingSleep = Math.max(0, targetInterval - fetchDuration);
                    
                    const hasTasksRemaining = taskIndex < fetchTasks.length || (useExpand && expansionIndex < expansionQueue.length);
                    if (hasTasksRemaining && isScanning && remainingSleep > 0) await wait(remainingSleep);
        
                    const actualCycleDuration = performance.now() - cycleStartTime;
                    if (hasMeasuredFirst) {
                        const diff = actualCycleDuration - estimatedMsPerPixel;
                        const weight = actualCycleDuration < estimatedMsPerPixel ? 0.8 : 0.05;
                        estimatedMsPerPixel += diff * weight;
                    } else {
                        estimatedMsPerPixel = actualCycleDuration;
                        hasMeasuredFirst = true;
                    }
        
                    const dynamicTotal = totalPixels + expansionQueue.length + activeVein.length;
                    const pct = ((processed / dynamicTotal) * 100).toFixed(1);
                    const pctFetched = ((fetched / dynamicTotal) * 100).toFixed(1);
                    const etaStr = formatETA(Math.round((uncachedRemaining * estimatedMsPerPixel) / 1000));
                    
                    statusDiv.innerHTML = `[${processed}/${dynamicTotal}${isExpansionTask ? ' (Expanding)' : ''} • <span style="color:#55ff55">${pct}%</span> • <span style="color:#55d2ff">${pctFetched}%</span>]<br>` +
                                          `Target: <b>${targetInterval}ms</b> (Floor: <b>${minFloorInterval}ms</b>)<br>` +
                                          `Avg: <b>${Math.round(estimatedMsPerPixel)}ms</b> • ETA: <b>${etaStr}</b><br>` +
                                          `Scanned: ${username}`;
                    drawVisualizerPixel(x, y, isColor ? 1 : 2);
        
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

        // Flush remaining expansion and polygon discoveries to Cloudflare
        if (useCloudDownload && Object.keys(cloudBatchQueue).length > 0) {
            statusDiv.innerHTML = `Syncing discoveries to cloud...`;
            const buckets = Object.values(cloudBatchQueue);
            cloudBatchQueue = {};
            for (const bucket of buckets) {
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
