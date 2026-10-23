// Selecting a stretch of the session: the band dragged on the profile chart,
// the distance and time inputs, and the stats re-run once the selection settles.

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
// Which canvas (pace or SPM profile chart) started the current drag.
// The pace and SPM profile charts share one selection (selectionStart/
// EndDistance) and can each start a drag, but only one gesture is ever
// active at a time, driven off whichever canvas it started on.
let activeDragCanvas = null;

// Binds the drag-to-select interaction once per canvas (which Chart.js
// reuses across chart re-creations). Handlers resolve the live Chart.js
// instance via Chart.getChart(canvas) on every call rather than closing
// over a chart instance, so they keep working correctly even after the
// chart has been destroyed and recreated (e.g. on loading new data).
function bindRangeSelector(canvas) {
    if (!canvas || canvas.dataset.rangeSelectorBound === 'true') {
        return;
    }
    canvas.dataset.rangeSelectorBound = 'true';
    canvas.style.cursor = 'crosshair';

    function startDrag(chart, pixel, distance) {
        const handle = getHandleNear(chart, pixel.x, pixel.y);
        if (handle === 'start') {
            rangeDragAnchorDistance = selectionEndDistance;
        } else if (handle === 'end') {
            rangeDragAnchorDistance = selectionStartDistance;
        } else {
            rangeDragAnchorDistance = distance;
            setSelectionRange(distance, distance);
        }
        rangeDragging = true;
        activeDragCanvas = canvas;
    }

    canvas.addEventListener('mousedown', (event) => {
        const chart = Chart.getChart(canvas);
        if (event.button !== 0 || !chart || !chart.chartArea) {
            return;
        }
        const pixel = eventToCanvasPixel(chart, event);
        if (pixel.x < chart.chartArea.left || pixel.x > chart.chartArea.right) {
            return;
        }
        const distance = clamp(chart.scales.x.getValueForPixel(pixel.x), 0, totalDistance);
        startDrag(chart, pixel, distance);
        event.preventDefault();
    });

    canvas.addEventListener('mousemove', (event) => {
        const chart = Chart.getChart(canvas);
        if (rangeDragging || !chart || !chart.chartArea) {
            return; // active drags are handled by the document-level listener below
        }
        const pixel = eventToCanvasPixel(chart, event);
        canvas.style.cursor = getHandleNear(chart, pixel.x, pixel.y) ? 'ew-resize' : 'crosshair';
    });

    canvas.addEventListener('touchstart', (event) => {
        const chart = Chart.getChart(canvas);
        if (!chart || !chart.chartArea || event.touches.length === 0) {
            return;
        }
        const pixel = eventToCanvasPixel(chart, event.touches[0]);
        if (pixel.x < chart.chartArea.left || pixel.x > chart.chartArea.right) {
            return;
        }
        const distance = clamp(chart.scales.x.getValueForPixel(pixel.x), 0, totalDistance);
        startDrag(chart, pixel, distance);
        event.preventDefault();
    }, {passive: false});

    // Double-click clears the selection (no dedicated "Reset" button).
    canvas.addEventListener('dblclick', (event) => {
        event.preventDefault();
        clearSelection();
    });
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
    activeDragCanvas = null;
    flushSelectionVisuals();
}

// Document-level drag-continuation listeners: bound once (not per
// canvas), driven off whichever chart's canvas started the current drag
// (activeDragCanvas) — see bindRangeSelector.
document.addEventListener('mousemove', (event) => {
    if (!rangeDragging || !activeDragCanvas) {
        return;
    }
    const chart = Chart.getChart(activeDragCanvas);
    if (!chart || !chart.chartArea) {
        return;
    }
    const pixel = eventToCanvasPixel(chart, event);
    const distance = clamp(chart.scales.x.getValueForPixel(pixel.x), 0, totalDistance);
    continueDrag(distance);
});

document.addEventListener('mouseup', endDrag);

document.addEventListener('touchmove', (event) => {
    if (!rangeDragging || !activeDragCanvas || event.touches.length === 0) {
        return;
    }
    const chart = Chart.getChart(activeDragCanvas);
    if (!chart || !chart.chartArea) {
        return;
    }
    const pixel = eventToCanvasPixel(chart, event.touches[0]);
    const distance = clamp(chart.scales.x.getValueForPixel(pixel.x), 0, totalDistance);
    continueDrag(distance);
    event.preventDefault();
}, {passive: false});

document.addEventListener('touchend', endDrag);

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
        return;
    }

    setAnalyzing(true);

    try {
        const stats = analyzeSection(gpsPoints, selectionStart, selectionEnd, DEFAULT_PAUSE_THRESHOLD);
        setAnalyzing(false);

        if (!stats) {
            document.getElementById('error').textContent = 'Invalid section range or not enough points';
            return;
        }

        updateStatsBox(stats);
        updateSelectedPaceChart();
    } catch (e) {
        setAnalyzing(false);
        document.getElementById('error').textContent = 'Error: ' + e;
    }
}

// Waits until the range has been stable for a bit before actually
// running analysis — since mousemove events during a drag keep
// resetting this timer, it naturally only fires once the user has
// finished adjusting the range, not on every intermediate position.
const AUTO_ANALYZE_DELAY_MS = 700;
const runAutoAnalysisDebounced = debounce(runAutoAnalysis, AUTO_ANALYZE_DELAY_MS);

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
