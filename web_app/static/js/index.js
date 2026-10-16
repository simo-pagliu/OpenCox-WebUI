// Global state
        let gpsPoints = [];
        let map;

        // The current selection, in meters along the track — this is the single
        // source of truth. It's what's drawn on the pace chart and what the map
        // highlight/section stats are derived from (via the index pair below).
        // Using distance (not point index) throughout avoids a subtle bug the old
        // slider had: GPS points are roughly evenly spaced in *time*, not distance
        // (a pause packs many points into a few meters), so an index-based '%'
        // position and a distance-based chart axis silently disagree.
        let selectionStartDistance = null;
        let selectionEndDistance = null;
        // Point indices into gpsPoints matching the distances above, kept in sync
        // by setSelectionRange() — these are what the map/stats API calls use.
        let selectionStart = null;
        let selectionEnd = null;

        // Every Leaflet layer currently drawn by renderMapOverlay(), so the
        // next render can remove exactly those before drawing its own.
        let mapOverlayLayers = [];
        let mapResizeObserver = null;

        let totalDistance = 0;
        let totalTime = 0;
        let cumulativeDistances = [];
        let cumulativeTimes = [];
        let allPaces = [];

        // Chart references
        let paceProfileChart = null;

        // Dark theme palette, kept in sync with the CSS custom properties in
        // index.css. Chart.js draws to canvas, so it needs its own copy of the
        // colors rather than inheriting them from the stylesheet.
        const THEME = {
            accent: '#4da3ff',
            accentSoft: 'rgba(77, 163, 255, 0.18)',
            highlight: '#8ecbff',
            cyan: '#22d3ee',
            dimTrack: '#3a4356',
            panelBg: '#1b212f',
            text: '#c7cee0',
            textMuted: '#8891a5',
            grid: 'rgba(255, 255, 255, 0.08)'
        };
        if (typeof Chart !== 'undefined') {
            Chart.defaults.color = THEME.text;
            Chart.defaults.borderColor = THEME.grid;
            Chart.defaults.font.size = 11;
        }

        // Shows exactly one of: the landing file picker, a full-page loading
        // spinner while a file is being fetched/processed, or the app itself.
        function setAppState(state) {
            const landing = document.getElementById('landing');
            const landingCard = document.getElementById('landingCard');
            const landingLoading = document.getElementById('landingLoading');
            const app = document.getElementById('app');
            const changeFileBar = document.getElementById('changeFileBar');

            if (state === 'ready') {
                landing.style.display = 'none';
                app.style.display = '';
                changeFileBar.style.display = '';
            } else {
                landing.style.display = 'flex';
                app.style.display = 'none';
                changeFileBar.style.display = 'none';
                landingCard.style.display = state === 'loading' ? 'none' : '';
                landingLoading.style.display = state === 'loading' ? 'flex' : 'none';
            }
        }

        // Selecting a file (from the landing picker or the "Open Different File"
        // button) uploads and processes it immediately — no separate "Upload"
        // button to press, and no separate "Clear" step: picking a new file just
        // replaces whatever was loaded before.
        function uploadCSVFile(file) {
            if (!file) {
                return;
            }

            document.getElementById('error').textContent = '';
            setAppState('loading');

            const formData = new FormData();
            formData.append('file', file);

            fetch('/api/upload_csv', {
                method: 'POST',
                body: formData
            })
            .then(r => r.json())
            .then(data => {
                if (data.status === 'success') {
                    // Reload the page to load and process the new file
                    window.location.reload();
                } else {
                    throw new Error(data.message || 'Upload failed');
                }
            })
            .catch(error => {
                console.error('Error uploading CSV file:', error);
                document.getElementById('error').textContent = 'Error: ' + error.message;
                // Restore whatever was showing before this failed upload attempt.
                loadCurrentData();
            });
        }

        function checkCurrentFileStatus() {
            return fetch('/api/current_csv')
                .then(r => r.json())
                .then(data => {
                    const statusEl = document.getElementById('current-file-status');
                    if (statusEl) {
                        statusEl.textContent = data.filename || '';
                    }
                    return data;
                })
                .catch(error => {
                    console.error('Error checking current file status:', error);
                    return {filename: null, is_uploaded: false};
                });
        }

        function loadCurrentData() {
            return checkCurrentFileStatus().then((status) => {
                if (!status.filename) {
                    gpsPoints = [];
                    setAppState('empty');
                    return;
                }

                setAppState('loading');

                return fetch('/api/gps_points')
                    .then(r => r.json())
                    .then(data => {
                        gpsPoints = data;
                        calculateCumulativeData();
                    })
                    .then(() => {
                        // Auto-process data on page load (without exclusions)
                        return fetch('/api/process', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({exclude_ranges: []})
                        });
                    })
                    .then(r => r.json())
                    .then(data => {
                        if (data.status === 'error') {
                            document.getElementById('error').textContent = data.message;
                            setAppState('empty');
                            return;
                        }

                        // Show the app (with its now-correctly-sized #map) before
                        // initializing Leaflet on it — initializing a map inside a
                        // display:none container leaves its internal size cache
                        // broken in ways invalidateSize() alone can't fully repair.
                        setAppState('ready');
                        return initMap().then(() => {
                            updateAnalysisUI(data);
                        });
                    });
            });
        }

        // Initialize the page: check for a current file, load its data, run analysis.
        loadCurrentData().catch(e => {
            document.getElementById('error').textContent = 'Error: ' + e;
        });

        function updateAnalysisUI(data) {
            // Show full track stats
            if (data.analysis && data.analysis.avg_speed) {
                // Store full track stats for later use
                window.fullTrackStats = data.analysis;

                // Show full track stats in the main stats box
                updateStatsBox(data.analysis);

                // Initialize the pace/SPM profile chart with full track data
                initPaceProfileChart();

                // Catch/exit duration + stroke shape charts (whole track, no selection yet)
                // Hidden until properly implemented:
                // refreshStrokeCharts();
            }

            // Map overlays are drawn from gpsPoints (the same points the
            // selection indices refer to), starting on the plain track.
            const dropdown = document.getElementById('layer-dropdown');
            if (dropdown) {
                dropdown.value = 'track';
            }
            // Layers added right after the map was created can be mispositioned
            // until Leaflet recomputes pixel geometry for the container's final size.
            map.invalidateSize();
            renderMapOverlay();
        }

        function calculateCumulativeData() {
            cumulativeDistances = [0];
            cumulativeTimes = [0];
            allPaces = [];
            totalDistance = 0;
            totalTime = 0;
            
            if (gpsPoints.length < 2) {
                // Not enough points to calculate distances and times
                return;
            }
            
            for (let i = 0; i < gpsPoints.length - 1; i++) {
                const p1 = gpsPoints[i];
                const p2 = gpsPoints[i + 1];
                
                // Calculate distance using haversine
                const dist = haversine(p1.lat, p1.lon, p2.lat, p2.lon);
                totalDistance += dist;
                cumulativeDistances.push(totalDistance);
                
                // Calculate time difference
                const timeDiff = (p2.time - p1.time) / 1000.0; // seconds
                totalTime += timeDiff;
                cumulativeTimes.push(cumulativeTimes[cumulativeTimes.length - 1] + timeDiff);
                
                // Calculate pace (seconds per 500m)
                if (dist > 0 && timeDiff > 0) {
                    const speed = dist / timeDiff;
                    const pace = 500.0 / speed;
                    allPaces.push(pace);
                } else {
                    allPaces.push(0);
                }
            }
            
            // Add last point
            cumulativeTimes.push(cumulativeTimes[cumulativeTimes.length - 1] + 
                (gpsPoints[gpsPoints.length - 1].time - gpsPoints[gpsPoints.length - 2].time) / 1000.0);
        }
        
        function haversine(lat1, lon1, lat2, lon2) {
            const R = 6371000; // Earth radius in meters
            const phi1 = lat1 * Math.PI / 180;
            const phi2 = lat2 * Math.PI / 180;
            const deltaPhi = (lat2 - lat1) * Math.PI / 180;
            const deltaLambda = (lon2 - lon1) * Math.PI / 180;
            
            const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
                      Math.cos(phi1) * Math.cos(phi2) *
                      Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            
            return R * c;
        }
        
        function initMap() {
            return new Promise((resolve) => {
                const hasPoints = gpsPoints.length > 0;
                const centerLat = hasPoints ? gpsPoints[Math.floor(gpsPoints.length / 2)].lat : 0;
                const centerLon = hasPoints ? gpsPoints[Math.floor(gpsPoints.length / 2)].lon : 0;

                // Canvas rendering: the Pace/SPM layers are one polyline per GPS
                // segment (thousands), which SVG redraws far more slowly.
                map = L.map('map', {preferCanvas: true}).setView([centerLat, centerLon], hasPoints ? 15 : 2);
                // CARTO's free basemaps.cartocdn.com raster tiles now require a
                // signed-up API key (every tile comes back as a watermarked "API
                // KEY REQUIRED" placeholder without one). Esri's World_Dark_Gray_Base
                // is a free, key-less dark basemap that keeps the same dark
                // aesthetic; it tops out at native zoom 16, so maxNativeZoom lets
                // Leaflet upscale its tiles for closer zooms instead of requesting
                // tiles that don't exist.
                L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
                    attribution: 'Tiles &copy; Esri',
                    maxZoom: 19,
                    maxNativeZoom: 16
                }).addTo(map);

                const fitToPoints = () => {
                    if (hasPoints) {
                        map.fitBounds(L.latLngBounds(gpsPoints.map(p => [p.lat, p.lon])));
                    }
                };
                fitToPoints();

                // The map container's final layout size can still be settling at
                // this point (sibling elements above it are still rendering), which
                // leaves Leaflet's cached size stale and layers mispositioned until
                // the user pans/zooms. Force a recalculation once layout settles.
                requestAnimationFrame(() => {
                    map.invalidateSize();
                    fitToPoints();
                    resolve();
                });

                // The map's panel is sized by the page layout, so it changes with
                // the window; keep Leaflet's cached size in step with it. The
                // #map element itself is permanent, so one observer is enough.
                if (!mapResizeObserver && typeof ResizeObserver !== 'undefined') {
                    mapResizeObserver = new ResizeObserver(() => {
                        if (map) {
                            map.invalidateSize();
                        }
                    });
                    mapResizeObserver.observe(map.getContainer());
                }
            });
        }
        
        // Delays fn until callers have been quiet for delayMs, coalescing bursts
        // (e.g. mousemove during a drag) into a single trailing call. flush() runs
        // it immediately (used on drag release, so the final state is exact and
        // there's no lingering delay after the user lets go).
        function debounce(fn, delayMs) {
            let timer = null;
            function debounced(...args) {
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => {
                    timer = null;
                    fn(...args);
                }, delayMs);
            }
            debounced.flush = () => {
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }
                fn();
            };
            debounced.cancel = () => {
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }
            };
            return debounced;
        }

        // Rebuilds the map highlight, active overlay, and selection pace chart from
        // the current selectionStart/selectionEnd. This is genuinely expensive (it
        // rebuilds Leaflet polylines over the whole track and recreates a Chart.js
        // chart) — expensive enough that running it on every single mousemove event,
        // even rate-limited to once per animation frame, still couldn't keep up and
        // made the slider feel laggy. It's debounced instead: while actively
        // dragging, only the cheap live feedback below runs; this heavy rebuild
        // fires shortly after the pointer settles, and immediately (via .flush())
        // the moment the drag ends.
        function syncSelectionVisualsHeavy() {
            renderMapOverlay();
            updateSelectedPaceChart();
        }
        const syncSelectionVisualsHeavyDebounced = debounce(syncSelectionVisualsHeavy, 120);

        // Cheap enough to run on every drag event: just redraws the selection band
        // already on the pace chart (a plugin-drawn canvas overlay), no layer or
        // Chart.js rebuilding.
        function syncSelectionVisualsLive() {
            redrawPaceProfileChart();
            syncSelectionVisualsHeavyDebounced();
        }

        // Runs the heavy rebuild right away, skipping the debounce delay. Call this
        // when a drag ends so the final state is exact with no lingering delay.
        function flushSelectionVisuals() {
            syncSelectionVisualsHeavyDebounced.flush();
        }

        function redrawPaceProfileChart() {
            if (!paceProfileChart) {
                paceProfileChart = Chart.getChart('paceProfileChart');
            }
            if (paceProfileChart) {
                paceProfileChart.update('none');
            }
        }

        function clamp(value, min, max) {
            return Math.max(min, Math.min(max, value));
        }

        function formatTime(seconds) {
            const minutes = Math.floor(seconds / 60);
            const secs = Math.floor(seconds % 60);
            return minutes + ':' + secs.toString().padStart(2, '0');
        }
        
        function formatPace(paceSeconds) {
            const minutes = Math.floor(paceSeconds / 60);
            const seconds = paceSeconds % 60;
            return minutes + ':' + seconds.toFixed(2).padStart(5, '0');
        }

        // Compact pace for axis ticks and legends: m:ss, or m:ss.s with decimals = 1.
        function formatPaceShort(paceSeconds, decimals = 0) {
            const factor = Math.pow(10, decimals);
            const rounded = Math.round(paceSeconds * factor) / factor;
            const minutes = Math.floor(rounded / 60);
            const seconds = rounded - minutes * 60;
            return minutes + ':' + seconds.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, '0');
        }

        function findNearestIndexByDistance(targetDistance) {
            let bestIndex = 0;
            let bestDelta = Infinity;

            for (let i = 0; i < cumulativeDistances.length; i++) {
                const delta = Math.abs(cumulativeDistances[i] - targetDistance);
                if (delta < bestDelta) {
                    bestDelta = delta;
                    bestIndex = i;
                }
            }

            return bestIndex;
        }

        // The single entry point for changing the selection: takes two distances
        // (in either order), normalizes/clamps them, and derives everything else
        // — point indices for the map/stats API, and the visible range inputs —
        // from that one pair of numbers.
        function setSelectionRange(startDistance, endDistance) {
            if (totalDistance <= 0 || cumulativeDistances.length < 2) {
                return;
            }

            selectionStartDistance = clamp(Math.min(startDistance, endDistance), 0, totalDistance);
            selectionEndDistance = clamp(Math.max(startDistance, endDistance), 0, totalDistance);

            selectionStart = findNearestIndexByDistance(selectionStartDistance);
            selectionEnd = findNearestIndexByDistance(selectionEndDistance);
            if (selectionEnd <= selectionStart) {
                selectionEnd = Math.min(gpsPoints.length - 1, selectionStart + 1);
            }

            updateRangeInputsFromSelection();
        }

        function updateRangeInputsFromSelection() {
            const distanceStartInput = document.getElementById('distance-start');
            const distanceEndInput = document.getElementById('distance-end');
            const timeStartInput = document.getElementById('time-start');
            const timeEndInput = document.getElementById('time-end');

            if (selectionStartDistance === null || selectionEndDistance === null) {
                if (distanceStartInput) distanceStartInput.value = '';
                if (distanceEndInput) distanceEndInput.value = '';
                if (timeStartInput) timeStartInput.value = '';
                if (timeEndInput) timeEndInput.value = '';
                return;
            }

            if (distanceStartInput) distanceStartInput.value = selectionStartDistance.toFixed(0) + 'm';
            if (distanceEndInput) distanceEndInput.value = selectionEndDistance.toFixed(0) + 'm';
            if (timeStartInput && cumulativeTimes[selectionStart] !== undefined) {
                timeStartInput.value = formatTime(cumulativeTimes[selectionStart]);
            }
            if (timeEndInput && cumulativeTimes[selectionEnd] !== undefined) {
                timeEndInput.value = formatTime(cumulativeTimes[selectionEnd]);
            }
        }

        // Draws the selection band and its two drag handles directly on the pace
        // chart, in the chart's own coordinate space. This is what keeps the
        // selector pixel-perfectly aligned with the chart no matter what — there's
        // no separate DOM element whose position/width has to be kept in sync.
        const HANDLE_GRAB_PX = 10;

        const rangeSelectorPlugin = {
            id: 'rangeSelectorPlugin',
            afterDraw(chart) {
                if (selectionStartDistance === null || selectionEndDistance === null || !chart.chartArea) {
                    return;
                }

                const {ctx, chartArea, scales} = chart;
                const left = scales.x.getPixelForValue(selectionStartDistance);
                const right = scales.x.getPixelForValue(selectionEndDistance);
                const handleY = chartArea.top + 14;

                ctx.save();
                ctx.fillStyle = THEME.accentSoft;
                ctx.fillRect(left, chartArea.top, right - left, chartArea.bottom - chartArea.top);

                [left, right].forEach((x) => {
                    ctx.strokeStyle = THEME.accent;
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(x, chartArea.top);
                    ctx.lineTo(x, chartArea.bottom);
                    ctx.stroke();

                    // Grab handle: a small rounded pill with a grip icon, so it
                    // reads as "drag me" rather than just a boundary line.
                    ctx.fillStyle = THEME.accent;
                    ctx.strokeStyle = THEME.panelBg;
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    if (ctx.roundRect) {
                        ctx.roundRect(x - 7, handleY - 10, 14, 20, 6);
                    } else {
                        ctx.rect(x - 7, handleY - 10, 14, 20);
                    }
                    ctx.fill();
                    ctx.stroke();

                    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
                    ctx.lineWidth = 1.5;
                    [-3, 0, 3].forEach((dx) => {
                        ctx.beginPath();
                        ctx.moveTo(x + dx, handleY - 5);
                        ctx.lineTo(x + dx, handleY + 5);
                        ctx.stroke();
                    });
                });
                ctx.restore();
            }
        };

        // Returns 'start', 'end', or null depending on whether (pixelX, pixelY) is
        // close enough to grab that handle.
        function getHandleNear(chart, pixelX, pixelY) {
            if (selectionStartDistance === null || selectionEndDistance === null || !chart.chartArea) {
                return null;
            }
            if (pixelY < chart.chartArea.top - 15 || pixelY > chart.chartArea.bottom) {
                return null;
            }

            const xStart = chart.scales.x.getPixelForValue(selectionStartDistance);
            const xEnd = chart.scales.x.getPixelForValue(selectionEndDistance);
            const distToStart = Math.abs(pixelX - xStart);
            const distToEnd = Math.abs(pixelX - xEnd);

            if (distToStart <= HANDLE_GRAB_PX && distToStart <= distToEnd) {
                return 'start';
            }
            if (distToEnd <= HANDLE_GRAB_PX) {
                return 'end';
            }
            return null;
        }

        function eventToCanvasPixel(chart, event) {
            const rect = chart.canvas.getBoundingClientRect();
            return {
                x: (event.clientX - rect.left) * (chart.width / rect.width),
                y: (event.clientY - rect.top) * (chart.height / rect.height)
            };
        }

        let rangeDragging = false;
        // The boundary NOT being dragged, fixed for the whole gesture — the
        // dragged boundary just tracks the pointer. This makes dragging one
        // handle past the other well-defined for free (they simply swap which
        // one is "start" vs "end", via the min/max normalizing in
        // setSelectionRange) instead of needing special "crossed over" handling.
        let rangeDragAnchorDistance = null;

        // Binds the drag-to-select interaction once, on the canvas element itself
        // (which Chart.js reuses across chart re-creations). Handlers reference
        // the `paceProfileChart` global directly rather than closing over a chart
        // instance passed in here, so they keep working correctly even after the
        // chart has been destroyed and recreated (e.g. on loading new data).
        function bindRangeSelector() {
            const canvas = paceProfileChart && paceProfileChart.canvas;
            if (!canvas || canvas.dataset.rangeSelectorBound === 'true') {
                return;
            }
            canvas.dataset.rangeSelectorBound = 'true';
            canvas.style.cursor = 'crosshair';

            function startDrag(pixel, distance) {
                const handle = getHandleNear(paceProfileChart, pixel.x, pixel.y);
                if (handle === 'start') {
                    rangeDragAnchorDistance = selectionEndDistance;
                } else if (handle === 'end') {
                    rangeDragAnchorDistance = selectionStartDistance;
                } else {
                    rangeDragAnchorDistance = distance;
                    setSelectionRange(distance, distance);
                }
                rangeDragging = true;
            }

            function continueDrag(distance) {
                setSelectionRange(rangeDragAnchorDistance, distance);
                syncSelectionVisualsLive();
                runAutoAnalysisDebounced();
            }

            function endDrag() {
                if (!rangeDragging) {
                    return;
                }
                rangeDragging = false;
                flushSelectionVisuals();
            }

            canvas.addEventListener('mousedown', (event) => {
                if (event.button !== 0 || !paceProfileChart || !paceProfileChart.chartArea) {
                    return;
                }
                const pixel = eventToCanvasPixel(paceProfileChart, event);
                if (pixel.x < paceProfileChart.chartArea.left || pixel.x > paceProfileChart.chartArea.right) {
                    return;
                }
                const distance = clamp(paceProfileChart.scales.x.getValueForPixel(pixel.x), 0, totalDistance);
                startDrag(pixel, distance);
                event.preventDefault();
            });

            canvas.addEventListener('mousemove', (event) => {
                if (rangeDragging || !paceProfileChart || !paceProfileChart.chartArea) {
                    return; // active drags are handled by the document-level listener below
                }
                const pixel = eventToCanvasPixel(paceProfileChart, event);
                canvas.style.cursor = getHandleNear(paceProfileChart, pixel.x, pixel.y) ? 'ew-resize' : 'crosshair';
            });

            document.addEventListener('mousemove', (event) => {
                if (!rangeDragging || !paceProfileChart || !paceProfileChart.chartArea) {
                    return;
                }
                const pixel = eventToCanvasPixel(paceProfileChart, event);
                const distance = clamp(paceProfileChart.scales.x.getValueForPixel(pixel.x), 0, totalDistance);
                continueDrag(distance);
            });

            document.addEventListener('mouseup', endDrag);

            canvas.addEventListener('touchstart', (event) => {
                if (!paceProfileChart || !paceProfileChart.chartArea || event.touches.length === 0) {
                    return;
                }
                const pixel = eventToCanvasPixel(paceProfileChart, event.touches[0]);
                if (pixel.x < paceProfileChart.chartArea.left || pixel.x > paceProfileChart.chartArea.right) {
                    return;
                }
                const distance = clamp(paceProfileChart.scales.x.getValueForPixel(pixel.x), 0, totalDistance);
                startDrag(pixel, distance);
                event.preventDefault();
            }, {passive: false});

            document.addEventListener('touchmove', (event) => {
                if (!rangeDragging || !paceProfileChart || !paceProfileChart.chartArea || event.touches.length === 0) {
                    return;
                }
                const pixel = eventToCanvasPixel(paceProfileChart, event.touches[0]);
                const distance = clamp(paceProfileChart.scales.x.getValueForPixel(pixel.x), 0, totalDistance);
                continueDrag(distance);
                event.preventDefault();
            }, {passive: false});

            document.addEventListener('touchend', endDrag);

            // Double-click clears the selection (no dedicated "Reset" button).
            canvas.addEventListener('dblclick', (event) => {
                event.preventDefault();
                clearSelection();
            });
        }

        function updateStatsBox(statsData) {
            // Update the main stats box with the provided stats
            // Use null checks and default values to prevent errors
            const totalDistance = (statsData.total_distance || 0).toFixed(1) + 'm';
            const totalTime = formatTime(statsData.total_time || 0);
            const avgSpeed = (statsData.avg_speed || 0).toFixed(3) + ' m/s';
            const avgPace = formatPace(statsData.avg_pace || 0);
            const avgSPM = (statsData.avg_spm || 0).toFixed(1);
            
            document.getElementById('analysis-distance').textContent = totalDistance;
            document.getElementById('analysis-time').textContent = totalTime;
            document.getElementById('analysis-avg-pace').textContent = avgPace;
            document.getElementById('analysis-avg-spm').textContent = avgSPM;
            
            // Update detailed stats for speed
            const speedAvg = (statsData.avg_speed || 0).toFixed(3) + ' m/s';
            const speedMedian = (statsData.median_speed || 0).toFixed(3) + ' m/s';
            const speedMin = (statsData.min_speed || 0).toFixed(3) + ' m/s';
            const speedMax = (statsData.max_speed || 0).toFixed(3) + ' m/s';
            const speedLow = (statsData.speed_percentile_1 || 0).toFixed(3) + ' m/s';
            const speedHigh = (statsData.speed_percentile_99 || 0).toFixed(3) + ' m/s';
            
            document.getElementById('speed-avg').textContent = speedAvg;
            document.getElementById('speed-median').textContent = speedMedian;
            document.getElementById('speed-min').textContent = speedMin;
            document.getElementById('speed-max').textContent = speedMax;
            document.getElementById('speed-low').textContent = speedLow;
            document.getElementById('speed-high').textContent = speedHigh;
            
            // Update detailed stats for pace
            const paceAvg = formatPace(statsData.avg_pace || 0);
            const paceMedian = formatPace(statsData.median_pace || 0);
            const paceMin = formatPace(statsData.min_pace || 0);
            const paceMax = formatPace(statsData.max_pace || 0);
            const paceLow = formatPace(statsData.pace_percentile_1 || 0);
            const paceHigh = formatPace(statsData.pace_percentile_99 || 0);
            
            document.getElementById('pace-avg').textContent = paceAvg;
            document.getElementById('pace-median').textContent = paceMedian;
            document.getElementById('pace-min').textContent = paceMin;
            document.getElementById('pace-max').textContent = paceMax;
            document.getElementById('pace-low').textContent = paceLow;
            document.getElementById('pace-high').textContent = paceHigh;
            
            // Update detailed stats for SPM (placeholders for now)
            const spmAvg = (statsData.avg_spm || 0).toFixed(1);
            const spmMedian = (statsData.median_spm || 0).toFixed(1);
            const spmMin = (statsData.min_spm || 0).toFixed(1);
            const spmMax = (statsData.max_spm || 0).toFixed(1);
            const spmLow = (statsData.spm_percentile_1 || 0).toFixed(1);
            const spmHigh = (statsData.spm_percentile_99 || 0).toFixed(1);
            
            document.getElementById('spm-avg').textContent = spmAvg;
            document.getElementById('spm-median').textContent = spmMedian;
            document.getElementById('spm-min').textContent = spmMin;
            document.getElementById('spm-max').textContent = spmMax;
            document.getElementById('spm-low').textContent = spmLow;
            document.getElementById('spm-high').textContent = spmHigh;

            // Show stats box
            document.getElementById('stats-box').classList.add('visible');

            updateDistributionCharts(statsData);
        }

        // Bucket raw values into evenly-sized bins between min/max, expressed as
        // a percentage of the (valid, in-range) sample count — a distribution,
        // not a raw histogram.
        function buildHistogram(values, min, max, binCount) {
            const filtered = (values || []).filter(v => typeof v === 'number' && isFinite(v) && v >= min && v <= max);
            if (filtered.length === 0) {
                return {binCenters: [], percentages: []};
            }

            const binWidth = (max - min) / binCount;
            const counts = new Array(binCount).fill(0);
            filtered.forEach(v => {
                let idx = Math.floor((v - min) / binWidth);
                idx = Math.max(0, Math.min(binCount - 1, idx));
                counts[idx]++;
            });

            const total = filtered.length;
            const percentages = counts.map(c => (c / total) * 100);
            const binCenters = counts.map((_, i) => min + (i + 0.5) * binWidth);
            return {binCenters, percentages};
        }

        function renderDistributionChart(canvasId, values, {min, max, binCount, formatLabel, axisTitle, tickStep}) {
            const canvas = document.getElementById(canvasId);
            if (!canvas) {
                return;
            }

            const existingChart = Chart.getChart(canvasId);
            if (existingChart) {
                existingChart.destroy();
            }

            const {binCenters, percentages} = buildHistogram(values, min, max, binCount);
            if (binCenters.length === 0) {
                return;
            }

            // Plot as a smoothed density curve (points at each bin's center,
            // connected with a monotone curve) rather than discrete bars.
            const points = binCenters.map((center, i) => ({x: center, y: percentages[i]}));

            new Chart(canvas.getContext('2d'), {
                type: 'line',
                data: {
                    datasets: [{
                        data: points,
                        borderColor: THEME.accent,
                        backgroundColor: THEME.accentSoft,
                        borderWidth: 2.5,
                        tension: 0.4,
                        cubicInterpolationMode: 'monotone',
                        pointRadius: 0,
                        pointHoverRadius: 5,
                        pointHitRadius: 12,
                        pointHoverBackgroundColor: THEME.accent,
                        fill: true
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    // Hover anywhere near a given x position (not just exactly on
                    // the invisible point) to show that bin's tooltip.
                    interaction: {
                        mode: 'nearest',
                        axis: 'x',
                        intersect: false
                    },
                    // The card's caption names the measure, so the axes only
                    // carry units (in the tick labels) to stay compact.
                    scales: {
                        x: {
                            type: 'linear',
                            min,
                            max,
                            title: {display: false, text: axisTitle},
                            ticks: {maxRotation: 0, autoSkip: true, maxTicksLimit: 5, stepSize: tickStep, callback: formatLabel},
                            grid: {display: false}
                        },
                        y: {
                            beginAtZero: true,
                            ticks: {maxTicksLimit: 5, callback: (v) => v + '%'}
                        }
                    },
                    plugins: {
                        legend: {display: false},
                        tooltip: {
                            callbacks: {
                                title: (items) => items.length ? formatLabel(items[0].parsed.x) : '',
                                label: (item) => item.parsed.y.toFixed(1) + '% of samples'
                            }
                        }
                    }
                }
            });
        }

        function updateDistributionCharts(statsData) {
            renderDistributionChart('paceDistributionChart', statsData.paces, {
                min: 80,
                max: 240,
                binCount: 16,
                tickStep: PACE_TICK_STEP,
                formatLabel: (v) => formatPaceShort(v),
                axisTitle: 'Pace (/500m)'
            });

            const validSpms = (statsData.spms || []).filter(v => v > 0);
            const spmMax = validSpms.length > 0 ? Math.max(...validSpms) : 40;
            renderDistributionChart('spmDistributionChart', statsData.spms, {
                min: 10,
                max: Math.max(40, Math.ceil(spmMax / 5) * 5),
                binCount: 12,
                formatLabel: (v) => v.toFixed(0),
                axisTitle: 'SPM'
            });
        }

        function updateStrokeDurationCharts(strokeStats) {
            const catchDurations = strokeStats.catch_durations_ms || [];
            const catchMax = catchDurations.length ? Math.max(...catchDurations) : 100;
            renderDistributionChart('catchDurationChart', catchDurations, {
                min: 0,
                max: Math.max(50, Math.ceil(catchMax / 10) * 10),
                binCount: 12,
                formatLabel: (v) => v.toFixed(0) + 'ms',
                axisTitle: 'Catch duration (ms)'
            });

            const exitDurations = strokeStats.exit_durations_ms || [];
            const exitMax = exitDurations.length ? Math.max(...exitDurations) : 100;
            renderDistributionChart('exitDurationChart', exitDurations, {
                min: 0,
                max: Math.max(50, Math.ceil(exitMax / 10) * 10),
                binCount: 12,
                formatLabel: (v) => v.toFixed(0) + 'ms',
                axisTitle: 'Exit duration (ms)'
            });
        }

        // Fetches catch/exit durations and stroke shapes for the current selection
        // (or the whole track, if none) and refreshes the three charts derived
        // from them. Uses uptime_ms — the monotonic clock shared by A and G rows —
        // rather than gps_points indices, since gpsPoints already carries each
        // point's uptime_ms and the backend can filter accel-derived events
        // directly against it.
        function refreshStrokeCharts() {
            let body = {};
            if (
                selectionStart !== null && selectionEnd !== null && selectionStart < selectionEnd &&
                gpsPoints[selectionStart] && gpsPoints[selectionEnd]
            ) {
                body = {
                    start_uptime_ms: gpsPoints[selectionStart].uptime_ms,
                    end_uptime_ms: gpsPoints[selectionEnd].uptime_ms
                };
            }

            fetch('/api/stroke_stats', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(body)
            })
                .then(r => r.json())
                .then(data => {
                    if (data.status === 'error') {
                        return;
                    }
                    updateStrokeDurationCharts(data.stroke_stats);
                    renderStrokeShapePlot(data.stroke_stats.shapes);
                })
                .catch(() => {
                    // Non-critical: the rest of the stats box still works without this.
                });
        }

        // ---------------------------------------------------------------
        // Stroke shape density plot
        //
        // Each stroke is logged as 5 acceleration-magnitude values at even
        // fractions (0, 1/4, 1/2, 3/4, 1) of that stroke's own duration —
        // see PicoStrokeDetector.SHAPE_FRACTIONS on the Pico. Plotting those
        // fractions directly against a fixed 0..T axis *is* the duration
        // normalization: no further time-warping is needed here.
        //
        // This chart is drawn on a plain canvas rather than through Chart.js:
        // the "density" is a 2D histogram (per-stroke curves accumulated into
        // x/y bins, lightly blurred, alpha-scaled per column) with a bold
        // average curve on top, which isn't a shape Chart.js's chart types
        // expose directly.
        // ---------------------------------------------------------------

        const STROKE_SHAPE_FRACTIONS = [0, 0.25, 0.5, 0.75, 1.0];
        let lastStrokeShapes = [];

        // Monotone cubic (Fritsch-Carlson) interpolant: passes exactly through
        // the given points without the overshoot a plain cubic spline could
        // introduce between just 5 points — important here since overshoot
        // would read as a fake acceleration bump that was never measured.
        function createMonotoneCubicInterpolant(xs, ys) {
            const n = xs.length;
            const dxs = [], ms = [];
            for (let i = 0; i < n - 1; i++) {
                const dx = xs[i + 1] - xs[i];
                const dy = ys[i + 1] - ys[i];
                dxs.push(dx);
                ms.push(dy / dx);
            }

            const c1s = [ms[0]];
            for (let i = 0; i < dxs.length - 1; i++) {
                const m0 = ms[i], m1 = ms[i + 1];
                if (m0 * m1 <= 0) {
                    c1s.push(0);
                } else {
                    const dx0 = dxs[i], dx1 = dxs[i + 1];
                    const common = dx0 + dx1;
                    c1s.push(3 * common / ((common + dx1) / m0 + (common + dx0) / m1));
                }
            }
            c1s.push(ms[ms.length - 1]);

            const c2s = [], c3s = [];
            for (let i = 0; i < c1s.length - 1; i++) {
                const c1 = c1s[i];
                const m = ms[i];
                const invDx = 1 / dxs[i];
                const common = c1 + c1s[i + 1] - m - m;
                c2s.push((m - c1 - common) * invDx);
                c3s.push(common * invDx * invDx);
            }

            return function (x) {
                let i = xs.length - 1;
                if (x >= xs[i]) {
                    return ys[i];
                }
                if (x <= xs[0]) {
                    return ys[0];
                }
                for (i = 0; i < xs.length - 1; i++) {
                    if (xs[i + 1] > x) {
                        break;
                    }
                }
                const diff = x - xs[i];
                return ys[i] + c1s[i] * diff + c2s[i] * diff * diff + c3s[i] * diff * diff * diff;
            };
        }

        function renderStrokeShapePlot(shapes) {
            lastStrokeShapes = (shapes || []).filter(s => Array.isArray(s) && s.length === STROKE_SHAPE_FRACTIONS.length);
            drawStrokeShapePlot();
        }

        function drawStrokeShapePlot() {
            const container = document.querySelector('.stroke-shape-canvas');
            const canvas = document.getElementById('strokeShapeChart');
            if (!container || !canvas) {
                return;
            }

            const dpr = window.devicePixelRatio || 1;
            const cssWidth = container.clientWidth;
            const cssHeight = container.clientHeight;
            if (cssWidth === 0 || cssHeight === 0) {
                return;
            }

            canvas.width = Math.round(cssWidth * dpr);
            canvas.height = Math.round(cssHeight * dpr);
            const ctx = canvas.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, cssWidth, cssHeight);

            const shapes = lastStrokeShapes;
            const margin = {top: 14, right: 16, bottom: 34, left: 48};
            const plotWidth = cssWidth - margin.left - margin.right;
            const plotHeight = cssHeight - margin.top - margin.bottom;
            if (plotWidth <= 0 || plotHeight <= 0) {
                return;
            }

            if (!shapes.length) {
                ctx.fillStyle = THEME.textMuted;
                ctx.font = '13px Arial';
                ctx.textAlign = 'center';
                ctx.fillText('Not enough strokes in this range', cssWidth / 2, cssHeight / 2);
                return;
            }

            let yMin = Infinity, yMax = -Infinity;
            shapes.forEach(s => s.forEach(v => {
                if (v < yMin) yMin = v;
                if (v > yMax) yMax = v;
            }));
            const yPad = Math.max((yMax - yMin) * 0.1, 0.05);
            yMin -= yPad;
            yMax += yPad;

            const COLS = 60;
            const ROWS = 48;
            const colFractions = [];
            for (let c = 0; c < COLS; c++) {
                colFractions.push(c / (COLS - 1));
            }

            // Accumulate every stroke's interpolated curve into a col x row
            // histogram, then lightly blur each column vertically so the
            // result reads as a continuous density band rather than blocks.
            const counts = Array.from({length: COLS}, () => new Array(ROWS).fill(0));
            shapes.forEach(values => {
                const interp = createMonotoneCubicInterpolant(STROKE_SHAPE_FRACTIONS, values);
                colFractions.forEach((frac, c) => {
                    const y = interp(frac);
                    const row = clamp(Math.round(((y - yMin) / (yMax - yMin)) * (ROWS - 1)), 0, ROWS - 1);
                    counts[c][row] += 1;
                });
            });

            const blurred = counts.map(col => {
                const out = new Array(ROWS).fill(0);
                for (let r = 0; r < ROWS; r++) {
                    let sum = 0, weight = 0;
                    for (let k = -2; k <= 2; k++) {
                        const rr = r + k;
                        if (rr < 0 || rr >= ROWS) {
                            continue;
                        }
                        const w = 1 / (1 + Math.abs(k));
                        sum += col[rr] * w;
                        weight += w;
                    }
                    out[r] = weight > 0 ? sum / weight : 0;
                }
                return out;
            });

            // Normalized per column: opacity reflects how likely each
            // acceleration value is *at that phase of the stroke*, i.e. a
            // conditional density, matching how a ridgeline/violin plot reads.
            const colMax = blurred.map(col => Math.max(...col, 0));

            const colWidth = plotWidth / COLS;
            const rowHeight = plotHeight / ROWS;
            const maxOpacity = 0.85;

            for (let c = 0; c < COLS; c++) {
                const cm = colMax[c];
                if (cm <= 0) {
                    continue;
                }
                const x = margin.left + c * colWidth;
                for (let r = 0; r < ROWS; r++) {
                    const v = blurred[c][r];
                    if (v <= 0) {
                        continue;
                    }
                    const alpha = (v / cm) * maxOpacity;
                    if (alpha < 0.02) {
                        continue;
                    }
                    const yTop = margin.top + plotHeight - (r + 1) * rowHeight;
                    ctx.fillStyle = `rgba(77, 163, 255, ${alpha.toFixed(3)})`;
                    ctx.fillRect(x, yTop, colWidth + 0.5, rowHeight + 0.5);
                }
            }

            // Bold average shape on top of the density band.
            const avgPoints = STROKE_SHAPE_FRACTIONS.map((_, i) => (
                shapes.reduce((acc, s) => acc + s[i], 0) / shapes.length
            ));
            const avgInterp = createMonotoneCubicInterpolant(STROKE_SHAPE_FRACTIONS, avgPoints);

            ctx.beginPath();
            colFractions.forEach((frac, c) => {
                const y = avgInterp(frac);
                const px = margin.left + c * colWidth + colWidth / 2;
                const py = margin.top + plotHeight - ((y - yMin) / (yMax - yMin)) * plotHeight;
                if (c === 0) {
                    ctx.moveTo(px, py);
                } else {
                    ctx.lineTo(px, py);
                }
            });
            ctx.strokeStyle = THEME.text;
            ctx.lineWidth = 2.5;
            ctx.stroke();

            // Axes
            ctx.strokeStyle = THEME.grid;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(margin.left, margin.top);
            ctx.lineTo(margin.left, margin.top + plotHeight);
            ctx.lineTo(margin.left + plotWidth, margin.top + plotHeight);
            ctx.stroke();

            const tickLabels = ['0', 'T/4', 'T/2', '3T/4', 'T'];
            ctx.fillStyle = THEME.textMuted;
            ctx.font = '12px Arial';
            ctx.textAlign = 'center';
            STROKE_SHAPE_FRACTIONS.forEach((frac, i) => {
                const px = margin.left + frac * plotWidth;
                ctx.beginPath();
                ctx.moveTo(px, margin.top + plotHeight);
                ctx.lineTo(px, margin.top + plotHeight + 5);
                ctx.strokeStyle = THEME.grid;
                ctx.stroke();
                ctx.fillText(tickLabels[i], px, margin.top + plotHeight + 20);
            });
            ctx.fillText('Normalized stroke phase (T = 2s)', margin.left + plotWidth / 2, cssHeight - 2);

            const yTickCount = 4;
            ctx.textAlign = 'right';
            for (let i = 0; i <= yTickCount; i++) {
                const val = yMin + (i / yTickCount) * (yMax - yMin);
                const py = margin.top + plotHeight - (i / yTickCount) * plotHeight;
                ctx.beginPath();
                ctx.moveTo(margin.left - 3, py);
                ctx.lineTo(margin.left, py);
                ctx.strokeStyle = THEME.grid;
                ctx.stroke();
                ctx.fillText(val.toFixed(2), margin.left - 6, py + 4);
            }

            ctx.save();
            ctx.translate(14, margin.top + plotHeight / 2);
            ctx.rotate(-Math.PI / 2);
            ctx.textAlign = 'center';
            ctx.fillText('Accel magnitude (g)', 0, 0);
            ctx.restore();
        }

        const redrawStrokeShapePlotDebounced = debounce(drawStrokeShapePlot, 150);
        window.addEventListener('resize', redrawStrokeShapePlotDebounced);

        function updateRangeFromInputs() {
            // Get input values (with null checks)
            const distanceStartEl = document.getElementById('distance-start');
            const distanceEndEl = document.getElementById('distance-end');
            const timeStartEl = document.getElementById('time-start');
            const timeEndEl = document.getElementById('time-end');
            
            const distanceStartInput = distanceStartEl ? distanceStartEl.value : '';
            const distanceEndInput = distanceEndEl ? distanceEndEl.value : '';
            const timeStartInput = timeStartEl ? timeStartEl.value : '';
            const timeEndInput = timeEndEl ? timeEndEl.value : '';
            
            // Try to parse distance inputs (remove 'm' and parse as float)
            let distanceStart = 0;
            let distanceEnd = totalDistance;
            
            if (distanceStartInput) {
                const distStart = parseFloat(distanceStartInput.replace('m', ''));
                if (!isNaN(distStart)) distanceStart = distStart;
            }
            
            if (distanceEndInput) {
                const distEnd = parseFloat(distanceEndInput.replace('m', ''));
                if (!isNaN(distEnd)) distanceEnd = distEnd;
            }
            
            // Try to parse time inputs (parse as minutes:seconds)
            let timeStart = 0;
            let timeEnd = totalTime;
            
            if (timeStartInput) {
                const parts = timeStartInput.split(':');
                if (parts.length === 2) {
                    const minutes = parseInt(parts[0]) || 0;
                    const seconds = parseInt(parts[1]) || 0;
                    timeStart = minutes * 60 + seconds;
                }
            }
            
            if (timeEndInput) {
                const parts = timeEndInput.split(':');
                if (parts.length === 2) {
                    const minutes = parseInt(parts[0]) || 0;
                    const seconds = parseInt(parts[1]) || 0;
                    timeEnd = minutes * 60 + seconds;
                }
            }
            
            if (gpsPoints.length < 2) {
                return;
            }

            function findNearestIndexByTime(targetTime) {
                let bestIndex = 0;
                let bestDelta = Infinity;
                for (let i = 0; i < cumulativeTimes.length; i++) {
                    const delta = Math.abs(cumulativeTimes[i] - targetTime);
                    if (delta < bestDelta) {
                        bestDelta = delta;
                        bestIndex = i;
                    }
                }
                return bestIndex;
            }

            let startDistance = distanceStart;
            let endDistance = distanceEnd;

            if (!distanceStartInput && !distanceEndInput && (timeStartInput || timeEndInput)) {
                startDistance = cumulativeDistances[findNearestIndexByTime(timeStart)];
                endDistance = cumulativeDistances[findNearestIndexByTime(timeEnd)];
            }

            setSelectionRange(startDistance, endDistance);
            // One-off change, not a drag — apply the local visuals immediately
            // rather than waiting out the drag debounce; the analysis itself
            // still runs on its own short delay, same as after a drag.
            redrawPaceProfileChart();
            flushSelectionVisuals();
            runAutoAnalysisDebounced();
        }

        // Toggles the small "Analyzing…" spinner next to the range inputs. Only
        // ever visible while a section_stats request triggered below is in flight.
        function setAnalyzing(isAnalyzing) {
            const indicator = document.getElementById('analyzingIndicator');
            if (indicator) {
                indicator.classList.toggle('visible', isAnalyzing);
            }
        }

        // Runs section analysis for the current selection and updates the stats
        // box with the result. Called automatically (debounced) after the range
        // stops changing — see runAutoAnalysisDebounced below — rather than from
        // an explicit "Analyze" button.
        function runAutoAnalysis() {
            if (selectionStart === null || selectionEnd === null || selectionStart >= selectionEnd) {
                if (window.fullTrackStats) {
                    updateStatsBox(window.fullTrackStats);
                }
                // refreshStrokeCharts();  // hidden until properly implemented
                return;
            }

            setAnalyzing(true);

            fetch('/api/section_stats', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({start_idx: selectionStart, end_idx: selectionEnd})
            })
            .then(r => r.json())
            .then(data => {
                setAnalyzing(false);

                if (data.status === 'error') {
                    document.getElementById('error').textContent = data.message;
                    return;
                }

                updateStatsBox(data.stats);
                updateSelectedPaceChart();
                // refreshStrokeCharts();  // hidden until properly implemented
            })
            .catch(e => {
                setAnalyzing(false);
                document.getElementById('error').textContent = 'Error: ' + e;
            });
        }

        // Waits until the range has been stable for a bit before actually
        // running the (network) analysis — since mousemove events during a drag
        // keep resetting this timer, it naturally only fires once the user has
        // finished adjusting the range, not on every intermediate position.
        const AUTO_ANALYZE_DELAY_MS = 700;
        const runAutoAnalysisDebounced = debounce(runAutoAnalysis, AUTO_ANALYZE_DELAY_MS);

        // Zoomed-in pace for just the selected range, on its own x scale from
        // the selection's start to its end. With no selection the card shows a
        // hint instead of an empty plot.
        function updateSelectedPaceChart() {
            const existingChart = Chart.getChart('selectionPaceChart');
            if (existingChart) {
                existingChart.destroy();
            }

            const hasSelection = selectionStart !== null && selectionEnd !== null && selectionStart < selectionEnd;
            const chartPoints = [];
            if (hasSelection) {
                for (let i = selectionStart; i < selectionEnd; i++) {
                    const pace = allPaces[i];
                    if (pace >= PACE_AXIS_MIN && pace <= PACE_AXIS_MAX) {
                        chartPoints.push({
                            x: (cumulativeDistances[i] + cumulativeDistances[i + 1]) / 2,
                            y: pace,
                            t: (cumulativeTimes[i] + cumulativeTimes[i + 1]) / 2
                        });
                    }
                }
            }

            const emptyHint = document.getElementById('selectionPaceEmpty');
            if (emptyHint) {
                emptyHint.style.display = chartPoints.length ? 'none' : '';
                emptyHint.textContent = hasSelection
                    ? 'No moving pace data in this range.'
                    : 'Select a range on the profile above to see its pace here.';
            }
            if (chartPoints.length === 0) {
                return;
            }

            new Chart(document.getElementById('selectionPaceChart').getContext('2d'), {
                type: 'line',
                data: {
                    datasets: [{
                        label: 'Pace',
                        data: chartPoints,
                        borderColor: THEME.accent,
                        backgroundColor: THEME.accentSoft,
                        borderWidth: 2,
                        tension: 0.35,
                        cubicInterpolationMode: 'monotone',
                        pointRadius: 0,
                        pointHoverRadius: 4,
                        pointHitRadius: 12,
                        pointHoverBackgroundColor: THEME.accent,
                        // The y-axis is reversed (faster pace at the top). Chart.js's
                        // 'start'/'end' fill keywords resolve to the axis's pixel
                        // start/end, which flips along with reverse and still shades
                        // the wrong side — so target an explicit scale value instead
                        // (the slow/max boundary), which always fills toward it.
                        fill: {value: PACE_AXIS_MAX}
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    // Hover anywhere near a given x position (not just exactly on
                    // the invisible point) to show that point's tooltip.
                    interaction: {
                        mode: 'nearest',
                        axis: 'x',
                        intersect: false
                    },
                    scales: {
                        y: {
                            min: PACE_AXIS_MIN,
                            max: PACE_AXIS_MAX,
                            reverse: true,
                            ticks: {stepSize: PACE_TICK_STEP, callback: (value) => formatPaceShort(value)}
                        },
                        x: {
                            type: 'linear',
                            min: cumulativeDistances[selectionStart],
                            max: cumulativeDistances[selectionEnd],
                            afterBuildTicks: (scale) => {
                                scale.ticks = buildDistanceTicks(scale);
                            },
                            // Plain meters: a zoomed range is often too short for
                            // formatDistanceLabel's 0.1 km steps to tell ticks apart.
                            ticks: {maxRotation: 0, autoSkip: true, callback: (value) => Math.round(value) + 'm'}
                        }
                    },
                    plugins: {
                        legend: {display: false},
                        tooltip: {
                            callbacks: {
                                title: profileTooltipTitle,
                                label: (item) => 'Pace: ' + formatPace(item.parsed.y) + ' /500m'
                            }
                        }
                    }
                }
            });
        }

        // Helper function to get adaptive distance tick interval
        // The smallest round step that keeps the axis to about ten labels. A
        // step that would need more makes Chart.js fall back to an arbitrary
        // spacing (labels like 987m, 3.9km).
        function getDistanceTickInterval(maxDistance) {
            const steps = [100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];
            return steps.find(step => maxDistance / step <= 10) || 20000;
        }
        
        // Helper function to format distance label
        function formatDistanceLabel(meters) {
            if (meters >= 1000) {
                return (meters / 1000).toFixed(1) + 'km';
            }
            return meters.toFixed(0) + 'm';
        }
        
        // Helper function to get adaptive time tick interval
        function getTimeTickInterval(maxTimeSeconds) {
            const maxTimeMinutes = maxTimeSeconds / 60;
            if (maxTimeMinutes <= 5) {
                return 60; // 1 minute intervals for short times
            } else if (maxTimeMinutes <= 20) {
                return 300; // 5 minute intervals for medium times
            } else if (maxTimeMinutes <= 60) {
                return 600; // 10 minute intervals for longer times
            } else {
                return 1800; // 30 minute intervals for very long times
            }
        }
        
        // Helper function to format time label as h:mm:ss
        function formatTimeLabel(seconds) {
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            const secs = Math.floor(seconds % 60);
            
            if (hours > 0) {
                return hours + ':' + minutes.toString().padStart(2, '0') + ':' + secs.toString().padStart(2, '0');
            }
            return minutes + ':' + secs.toString().padStart(2, '0');
        }
        
        // Pace axis range shared by the profile and selection charts (1:20 to
        // 4:00 /500m); segments outside it (pauses, GPS spikes) aren't plotted.
        const PACE_AXIS_MIN = 80;
        const PACE_AXIS_MAX = 240;
        const PACE_TICK_STEP = 40; // 1:20, 2:00, 2:40, 3:20, 4:00

        // Tooltip title for points carrying {x: distance, t: elapsed seconds}.
        function profileTooltipTitle(items) {
            if (!items.length) {
                return '';
            }
            const raw = items[0].raw;
            return Math.round(raw.x) + ' m · ' + formatTimeLabel(raw.t);
        }

        // Distance covered after `seconds` of elapsed time, interpolated
        // between GPS points (cumulativeTimes is non-decreasing).
        function distanceAtTime(seconds) {
            const n = cumulativeDistances.length;
            if (n === 0) {
                return 0;
            }
            if (seconds <= cumulativeTimes[0]) {
                return cumulativeDistances[0];
            }
            if (seconds >= cumulativeTimes[n - 1]) {
                return cumulativeDistances[n - 1];
            }
            let lo = 0;
            let hi = n - 1;
            while (hi - lo > 1) {
                const mid = (lo + hi) >> 1;
                if (cumulativeTimes[mid] <= seconds) {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            const span = cumulativeTimes[hi] - cumulativeTimes[lo];
            const fraction = span > 0 ? (seconds - cumulativeTimes[lo]) / span : 0;
            return cumulativeDistances[lo] + fraction * (cumulativeDistances[hi] - cumulativeDistances[lo]);
        }

        // Round-distance ticks (every getDistanceTickInterval meters) for an
        // axis with an explicit min/max. Chart.js's own stepSize can't be used
        // here: with both bounds set it stretches the step to divide the range
        // evenly, giving labels like 2.1km, 4.2km.
        function buildDistanceTicks(scale) {
            const step = getDistanceTickInterval(scale.max - scale.min);
            const ticks = [];
            for (let d = Math.ceil(scale.min / step) * step; d <= scale.max; d += step) {
                ticks.push({value: d});
            }
            return ticks;
        }

        // Ticks for the profile's top (time) axis. The chart's x axis is
        // distance, and time isn't linear in distance (a pause spends minutes in
        // a few meters), so each round time is placed at the distance covered
        // by then. Labels that would land too close together (during a pause)
        // are dropped.
        const TIME_TICK_MIN_GAP_PX = 56;

        function buildTimeAxisTicks(scale) {
            const step = getTimeTickInterval(totalTime);
            const metersPerPixel = (scale.max - scale.min) / Math.max(scale.width || 1, 1);
            const minGapMeters = TIME_TICK_MIN_GAP_PX * metersPerPixel;
            const ticks = [];
            let lastDistance = -Infinity;
            for (let t = 0; t <= totalTime; t += step) {
                const distance = distanceAtTime(t);
                if (distance - lastDistance >= minGapMeters) {
                    ticks.push({value: distance, timeLabel: formatTimeLabel(t)});
                    lastDistance = distance;
                }
            }
            return ticks;
        }

        // Hover mode for the profile chart's two stacked panels: the point
        // nearest in x within whichever panel (pace or SPM) the pointer is
        // over. Chart.js's own 'nearest' mode compares points across both
        // panels and would often pick one from the other panel.
        const PROFILE_HOVER_MODE = (typeof Chart !== 'undefined' && Chart.Interaction && Chart.Interaction.modes)
            ? 'profilePanel'
            : 'nearest';
        if (PROFILE_HOVER_MODE === 'profilePanel') {
            Chart.Interaction.modes.profilePanel = function (chart, event) {
                const datasetIndex = chart.data.datasets.findIndex((dataset) => {
                    const scale = chart.scales[dataset.yAxisID];
                    return scale && event.y >= scale.top && event.y <= scale.bottom;
                });
                if (datasetIndex < 0) {
                    return [];
                }
                let best = null;
                chart.getDatasetMeta(datasetIndex).data.forEach((element, index) => {
                    if (element.skip) {
                        return;
                    }
                    const dx = Math.abs(element.x - event.x);
                    if (!best || dx < best.dx) {
                        best = {element, datasetIndex, index, dx};
                    }
                });
                return best ? [best] : [];
            };
        }

        // The profile chart: pace (top) and SPM (bottom) as two stacked panels
        // of one chart, sharing the distance axis (bottom) and the time axis
        // (top). Being one chart keeps the panels pixel-aligned, and the
        // selection band (rangeSelectorPlugin) spans both.
        function initPaceProfileChart() {
            const canvas = document.getElementById('paceProfileChart');
            if (!canvas || allPaces.length === 0) {
                return;
            }

            const existingChart = Chart.getChart(canvas);
            if (existingChart) {
                existingChart.destroy();
            }

            // Pace per segment, plotted at the segment's midpoint.
            const pacePoints = [];
            for (let i = 0; i < allPaces.length; i++) {
                const pace = allPaces[i];
                if (pace >= PACE_AXIS_MIN && pace <= PACE_AXIS_MAX) {
                    pacePoints.push({
                        x: (cumulativeDistances[i] + cumulativeDistances[i + 1]) / 2,
                        y: pace,
                        t: (cumulativeTimes[i] + cumulativeTimes[i + 1]) / 2
                    });
                }
            }

            // SPM as logged at each GPS point. 0 means "no recent strokes
            // detected": leave a gap (null) rather than drawing down to zero.
            const spmPoints = gpsPoints.map((point, i) => ({
                x: cumulativeDistances[i],
                y: point.spm > 0 ? point.spm : null,
                t: cumulativeTimes[i]
            }));

            paceProfileChart = new Chart(canvas.getContext('2d'), {
                type: 'line',
                data: {
                    datasets: [{
                        label: 'Pace',
                        yAxisID: 'yPace',
                        data: pacePoints,
                        borderColor: THEME.accent,
                        backgroundColor: THEME.accentSoft,
                        borderWidth: 2,
                        tension: 0.35,
                        cubicInterpolationMode: 'monotone',
                        pointRadius: 0,
                        pointHoverRadius: 4,
                        pointHitRadius: 12,
                        pointHoverBackgroundColor: THEME.accent,
                        // The y-axis is reversed (faster pace at the top). Chart.js's
                        // 'start'/'end' fill keywords resolve to the axis's pixel
                        // start/end, which flips along with reverse and still shades
                        // the wrong side — so target an explicit scale value instead
                        // (the slow/max boundary), which always fills toward it.
                        fill: {value: PACE_AXIS_MAX}
                    }, {
                        label: 'SPM',
                        yAxisID: 'ySpm',
                        data: spmPoints,
                        borderColor: THEME.accent,
                        borderWidth: 1.5,
                        tension: 0.2,
                        cubicInterpolationMode: 'monotone',
                        pointRadius: 0,
                        pointHoverRadius: 4,
                        pointHitRadius: 12,
                        pointHoverBackgroundColor: THEME.accent
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: {
                        mode: PROFILE_HOVER_MODE,
                        axis: 'x',
                        intersect: false
                    },
                    scales: {
                        x: {
                            type: 'linear',
                            position: 'bottom',
                            min: 0,
                            max: totalDistance,
                            afterBuildTicks: (scale) => {
                                scale.ticks = buildDistanceTicks(scale);
                            },
                            ticks: {
                                maxRotation: 0,
                                autoSkip: true,
                                callback: (value) => formatDistanceLabel(value)
                            }
                        },
                        xTime: {
                            type: 'linear',
                            position: 'top',
                            min: 0,
                            max: totalDistance,
                            afterBuildTicks: (scale) => {
                                scale.ticks = buildTimeAxisTicks(scale);
                            },
                            ticks: {
                                autoSkip: false,
                                maxRotation: 0,
                                callback: (value, index, ticks) => (ticks[index] ? ticks[index].timeLabel : '')
                            },
                            grid: {drawOnChartArea: false}
                        },
                        // Stacked panels: Chart.js draws the last listed axis of
                        // a stack on top, so SPM is listed first to sit below pace.
                        ySpm: {
                            stack: 'profile',
                            stackWeight: 2,
                            suggestedMin: 16,
                            suggestedMax: 40,
                            title: {display: true, text: 'SPM'},
                            // The top label would sit on the panel boundary, on top
                            // of the pace panel's bottom label.
                            ticks: {maxTicksLimit: 4, callback: (value, index, ticks) => (index === ticks.length - 1 ? '' : value)}
                        },
                        yPace: {
                            stack: 'profile',
                            stackWeight: 3,
                            min: PACE_AXIS_MIN,
                            max: PACE_AXIS_MAX,
                            reverse: true,
                            title: {display: true, text: 'Pace /500m'},
                            ticks: {stepSize: PACE_TICK_STEP, callback: (value) => formatPaceShort(value)}
                        }
                    },
                    plugins: {
                        legend: {
                            display: false
                        },
                        tooltip: {
                            callbacks: {
                                title: profileTooltipTitle,
                                label: (item) => (item.dataset.yAxisID === 'yPace'
                                    ? 'Pace: ' + formatPace(item.parsed.y) + ' /500m'
                                    : 'SPM: ' + item.parsed.y.toFixed(1))
                            }
                        }
                    }
                },
                plugins: [rangeSelectorPlugin]
            });

            bindRangeSelector(canvas);
            redrawPaceProfileChart();
            updateSelectedPaceChart();
        }

        function clearSelection() {
            selectionStartDistance = null;
            selectionEndDistance = null;
            selectionStart = null;
            selectionEnd = null;
            rangeDragging = false;
            rangeDragAnchorDistance = null;
            // Don't let a stale pending analysis/redraw for the old selection
            // overwrite the full-track view we're about to restore below.
            runAutoAnalysisDebounced.cancel();
            syncSelectionVisualsHeavyDebounced.cancel();
            setAnalyzing(false);

            updateRangeInputsFromSelection();

            // Show full track stats
            if (window.fullTrackStats) {
                updateStatsBox(window.fullTrackStats);
            }

            redrawPaceProfileChart();
            renderMapOverlay();
            updateSelectedPaceChart();
        }


        // ---------------------------------------------------------------
        // Map overlays and their color scale
        //
        // Pace and SPM share one sequential blue ramp, dark to light, so "more"
        // (a faster pace, a higher rate) always reads brighter on the dark
        // basemap. The legend's gradient is built from the same stops, so the
        // bar matches the line colors exactly. Segments without a meaningful
        // value (paused, or no strokes detected) are drawn thinner, in gray.
        // ---------------------------------------------------------------

        const COLOR_RAMP = ['#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'];
        const COLOR_RAMP_RGB = COLOR_RAMP.map(hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)));
        const NO_DATA_COLOR = '#5c5f66';
        const PAUSED_SPEED_THRESHOLD = 1.5; // m/s
        // Share of values (at each end) a relative range leaves out, so a few
        // GPS spikes don't stretch the whole scale.
        const RELATIVE_RANGE_PERCENTILE = 5;

        // Per layer: legend text, how to read and format a segment's value,
        // and the absolute range as [dark end, bright end]. For pace the dark
        // (slow) end is the larger number.
        const OVERLAY_SCALES = {
            pace: {
                title: 'Pace (/500m)',
                absoluteRange: [180, 100], // 3:00 to 1:40
                noDataLabel: 'Paused',
                valueAt: (i) => allPaces[i] || 0,
                hasValue: (pace) => pace > 0 && pace <= 500 / PAUSED_SPEED_THRESHOLD,
                // Tenths once the range is narrow enough for whole seconds to repeat
                formatTick: (pace, span) => formatPaceShort(pace, span < 8 ? 1 : 0),
                formatTooltip: (pace) => formatPace(pace) + ' /500m'
            },
            spm: {
                title: 'Stroke rate (SPM)',
                absoluteRange: [16, 40],
                noDataLabel: 'No strokes',
                valueAt: (i) => gpsPoints[i].spm || 0,
                hasValue: (spm) => spm > 0,
                formatTick: (spm, span) => spm.toFixed(span < 8 ? 1 : 0),
                formatTooltip: (spm) => spm.toFixed(1) + ' SPM'
            }
        };

        // 'absolute': the fixed ranges above, comparable across sessions.
        // 'relative': fitted to the values on screen (the selection, if there
        // is one), so variation within a piece stands out.
        let colorScaleMode = 'absolute';

        function setColorScaleMode(mode) {
            if (mode === colorScaleMode) {
                return;
            }
            colorScaleMode = mode;
            renderMapOverlay();
        }

        // t in [0, 1] -> color along COLOR_RAMP (linear between stops).
        function rampColor(t) {
            const scaled = clamp(t, 0, 1) * (COLOR_RAMP_RGB.length - 1);
            const i = Math.min(Math.floor(scaled), COLOR_RAMP_RGB.length - 2);
            const fraction = scaled - i;
            const from = COLOR_RAMP_RGB[i];
            const to = COLOR_RAMP_RGB[i + 1];
            return 'rgb(' + from.map((c, k) => Math.round(c + (to[k] - c) * fraction)).join(', ') + ')';
        }

        function percentileOfSorted(sorted, pct) {
            const k = (sorted.length - 1) * (pct / 100);
            const f = Math.floor(k);
            const c = Math.ceil(k);
            return sorted[f] + (sorted[c] - sorted[f]) * (k - f);
        }

        // [dark end, bright end] for this layer over segments startIdx..endIdx-1.
        function getColorRange(type, startIdx, endIdx) {
            const scale = OVERLAY_SCALES[type];
            if (colorScaleMode !== 'relative') {
                return scale.absoluteRange;
            }

            const values = [];
            for (let i = startIdx; i < endIdx; i++) {
                const value = scale.valueAt(i);
                if (scale.hasValue(value)) {
                    values.push(value);
                }
            }
            if (values.length < 2) {
                return scale.absoluteRange;
            }

            values.sort((a, b) => a - b);
            let low = percentileOfSorted(values, RELATIVE_RANGE_PERCENTILE);
            let high = percentileOfSorted(values, 100 - RELATIVE_RANGE_PERCENTILE);
            if (high - low < 1) {
                const mid = (low + high) / 2;
                low = mid - 0.5;
                high = mid + 0.5;
            }
            // Same orientation as the absolute range (pace runs slow to fast).
            const [darkEnd, brightEnd] = scale.absoluteRange;
            return darkEnd > brightEnd ? [high, low] : [low, high];
        }

        function colorForValue(value, range) {
            const [darkEnd, brightEnd] = range;
            return rampColor((value - darkEnd) / (brightEnd - darkEnd));
        }

        // One polyline per GPS segment from startIdx to endIdx, colored by that
        // segment's value, each with its own hover tooltip.
        function buildColoredOverlay(type, startIdx, endIdx, range) {
            const scale = OVERLAY_SCALES[type];
            const layerGroup = L.layerGroup();

            for (let i = startIdx; i < endIdx; i++) {
                const p1 = gpsPoints[i];
                const p2 = gpsPoints[i + 1];
                const value = scale.valueAt(i);
                const hasValue = scale.hasValue(value);

                L.polyline([[p1.lat, p1.lon], [p2.lat, p2.lon]], {
                    color: hasValue ? colorForValue(value, range) : NO_DATA_COLOR,
                    weight: hasValue ? 5 : 3,
                    opacity: 0.95
                })
                    .bindTooltip(hasValue ? scale.formatTooltip(value) : scale.noDataLabel, {
                        sticky: true,
                        direction: 'right',
                        offset: [10, 0]
                    })
                    .addTo(layerGroup);
            }

            return layerGroup;
        }

        // Draws the map overlay for the layer picked in the dropdown. With a
        // selection, the whole track is dimmed and only the selected part gets
        // the highlight (Track) or the color scale (Pace/SPM).
        function renderMapOverlay() {
            if (!map) {
                return;
            }
            mapOverlayLayers.forEach(layer => map.removeLayer(layer));
            mapOverlayLayers = [];

            if (gpsPoints.length < 2) {
                hideLegend();
                return;
            }

            const type = document.getElementById('layer-dropdown').value;
            const hasSelection = selectionStart !== null && selectionEnd !== null && selectionStart < selectionEnd;
            const startIdx = hasSelection ? selectionStart : 0;
            const endIdx = hasSelection ? selectionEnd : gpsPoints.length - 1;
            const toLatLng = (p) => [p.lat, p.lon];

            if (hasSelection) {
                mapOverlayLayers.push(L.polyline(gpsPoints.map(toLatLng), {
                    color: THEME.dimTrack,
                    weight: 2,
                    opacity: 0.6
                }));
            }

            if (OVERLAY_SCALES[type]) {
                const range = getColorRange(type, startIdx, endIdx);
                mapOverlayLayers.push(buildColoredOverlay(type, startIdx, endIdx, range));
                renderLegend(type, range, hasSelection);
            } else {
                mapOverlayLayers.push(L.polyline(
                    gpsPoints.slice(startIdx, endIdx + 1).map(toLatLng),
                    hasSelection ? {color: THEME.highlight, weight: 4, opacity: 1.0} : {color: THEME.accent, weight: 3}
                ));
                hideLegend();
            }

            mapOverlayLayers.forEach(layer => layer.addTo(map));
        }

        const LEGEND_TICK_FRACTIONS = [0, 0.25, 0.5, 0.75, 1];

        function renderLegend(type, range, hasSelection) {
            const scale = OVERLAY_SCALES[type];
            const [darkEnd, brightEnd] = range;
            const span = Math.abs(brightEnd - darkEnd);

            document.getElementById('legend-title').textContent = scale.title;
            document.getElementById('legend-bar').style.background = 'linear-gradient(to right, ' + COLOR_RAMP.join(', ') + ')';
            document.getElementById('legend-ticks').replaceChildren(...LEGEND_TICK_FRACTIONS.map((fraction) => {
                const label = document.createElement('span');
                label.style.left = (fraction * 100) + '%';
                label.textContent = scale.formatTick(darkEnd + (brightEnd - darkEnd) * fraction, span);
                return label;
            }));
            document.getElementById('legend-nodata-label').textContent = scale.noDataLabel;
            document.getElementById('legend-scope').textContent = colorScaleMode === 'relative'
                ? (hasSelection ? 'Fitted to selection' : 'Fitted to this session')
                : 'Fixed range';
            document.querySelectorAll('.scale-toggle button').forEach((button) => {
                button.setAttribute('aria-pressed', String(button.dataset.scale === colorScaleMode));
            });
            document.getElementById('colorbar-fixed').classList.add('visible');
        }

        function hideLegend() {
            document.getElementById('colorbar-fixed').classList.remove('visible');
        }

        function findNearestPoint(latlng) {
            let minDist = Infinity;
            let minIdx = 0;
            for (let i = 0; i < gpsPoints.length; i++) {
                const p = gpsPoints[i];
                const dist = Math.sqrt(
                    Math.pow(p.lat - latlng.lat, 2) + 
                    Math.pow(p.lon - latlng.lng, 2)
                );
                if (dist < minDist) {
                    minDist = dist;
                    minIdx = i;
                }
            }
            return minIdx;
        }

