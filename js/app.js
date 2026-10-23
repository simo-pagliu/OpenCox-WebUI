// Opening a file, resetting the page, and startup. Loaded last.

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
// button) loads and processes it immediately, entirely in the browser —
// no upload, no separate "Upload" button, no separate "Clear" step:
// picking a new file just replaces whatever was loaded before.
function uploadCSVFile(file) {
    if (!file) {
        return;
    }

    document.getElementById('error').textContent = '';
    setAppState('loading');

    const reader = new FileReader();
    reader.onload = () => {
        resetLoadedData();
        try {
            const log = loadLogFromCsvText(reader.result);
            gpsPoints = log.points;
            calculateCumulativeData();
            placeStrokes(log.strokes);

            const statusEl = document.getElementById('current-file-status');
            if (statusEl) {
                statusEl.textContent = file.name;
            }

            if (gpsPoints.length < 2) {
                throw new Error('Not enough GPS data for analysis.');
            }

            const analysis = analyzeSection(gpsPoints, 0, gpsPoints.length - 1, DEFAULT_PAUSE_THRESHOLD);

            // Show the app (with its now-correctly-sized #map) before
            // initializing Leaflet on it — initializing a map inside a
            // display:none container leaves its internal size cache
            // broken in ways invalidateSize() alone can't fully repair.
            setAppState('ready');
            initMap().then(() => {
                updateAnalysisUI(analysis);
            });
        } catch (error) {
            console.error('Error processing CSV file:', error);
            document.getElementById('error').textContent = 'Error: ' + error.message;
            gpsPoints = [];
            setAppState('empty');
        }
    };
    reader.onerror = () => {
        document.getElementById('error').textContent = 'Error reading file.';
        setAppState('empty');
    };
    reader.readAsText(file);
}

// Drops everything derived from the previously loaded file: the map
// (Leaflet can't initialize the same element twice, which used to throw
// and leave the first file on screen), the charts, the selection, and
// any pending analysis, so the next file starts from a clean slate.
function resetLoadedData() {
    runAutoAnalysisDebounced.cancel();
    syncSelectionVisualsHeavyDebounced.cancel();
    setAnalyzing(false);
    selectionStartDistance = null;
    selectionEndDistance = null;
    selectionStart = null;
    selectionEnd = null;
    rangeDragging = false;
    rangeDragAnchorDistance = null;
    activeDragCanvas = null;
    updateRangeInputsFromSelection();

    if (map) {
        map.remove();
        map = null;
    }
    mapOverlayLayers = [];
    ['paceProfileChart', 'selectionPaceChart', 'paceDistributionChart', 'spmDistributionChart'].forEach((id) => {
        const chart = Chart.getChart(id);
        if (chart) {
            chart.destroy();
        }
    });
    paceProfileChart = null;
    allStrokes = [];
    segmentPaces = [];
    window.fullTrackStats = null;
    document.getElementById('layer-dropdown').value = 'track';
    hideLegend();
}

function updateAnalysisUI(analysis) {
    // Show full track stats
    if (analysis && analysis.avg_speed !== undefined) {
        // Store full track stats for later use
        window.fullTrackStats = analysis;

        // Show full track stats in the main stats box
        updateStatsBox(analysis);

        // Initialize the pace/SPM profile chart with full track data
        initPaceProfileChart();
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

// The controls are wired here rather than with on* attributes in index.html.
function bindControls() {
    ['csv-file-upload', 'csv-file-change'].forEach((id) => {
        document.getElementById(id).addEventListener('change', (event) => {
            uploadCSVFile(event.target.files[0]);
            // Picking the same file again must still fire 'change'.
            event.target.value = '';
        });
    });
    ['distance-start', 'distance-end', 'time-start', 'time-end'].forEach((id) => {
        document.getElementById(id).addEventListener('change', updateRangeFromInputs);
    });
    document.getElementById('layer-dropdown').addEventListener('change', renderMapOverlay);
    document.querySelectorAll('.scale-toggle button').forEach((button) => {
        button.addEventListener('click', () => setColorScaleMode(button.dataset.scale));
    });
}

// The deployment's settings from config.js: the home button and the footer.
// A missing or empty setting leaves that part out.
function applyConfig() {
    const config = window.OPENCOX_CONFIG || {};
    if (config.homeUrl) {
        const home = document.getElementById('homeButton');
        home.href = config.homeUrl;
        home.hidden = false;
    }

    const parts = [];
    if (config.footerText) {
        parts.push(footerItem(config.footerText, config.footerUrl));
    }
    if (config.repoUrl) {
        parts.push(footerItem('Source code', config.repoUrl));
    }
    const footer = document.getElementById('pageFooter');
    parts.forEach((part, i) => {
        if (i > 0) {
            footer.append(' · ');
        }
        footer.append(part);
    });
    footer.hidden = parts.length === 0;
}

// Footer text, as a link when it has a URL.
function footerItem(text, url) {
    if (!url) {
        return text;
    }
    const link = document.createElement('a');
    link.href = url;
    link.textContent = text;
    return link;
}

// Start at the landing/file-picker state, with the deployment's settings
// applied and the controls wired up.
applyConfig();
bindControls();
setAppState('empty');
