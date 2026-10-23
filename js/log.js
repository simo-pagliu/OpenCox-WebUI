// Reading a log: CSV parsing, the GPS points, strokes from the catches, and
// the stats for a stretch of the session.

// --- CSV parsing and GPS analysis, entirely client-side with no
// server round trip. ---

const MIXED_HEADER = [
    'record_type', 'date', 'time', 'uptime_ms', 'accel_x', 'accel_y', 'accel_z',
    'gyro_x', 'gyro_y', 'gyro_z', 'speed_mps', 'spm', 'gps_lat', 'gps_lon',
    'distance_m', 'stroke_flag', 'sats', 'hdop', 'fix_quality', 'course_deg'
];
const DEFAULT_PAUSE_THRESHOLD = 1.5;
const MAX_GPS_POINT_SPEED_MPS = 15.0;
// The firmware logs a G row per fix, at 5 Hz since October 2026.
// Distance comes from consecutive points, and over 0.2 s steps the
// position jitter of every fix adds up, so only points at least ~1 s
// apart are kept (50 ms of slack for 0.999 s gaps), the same steps the
// firmware uses for its own distance. 1 Hz logs keep every point.
// Pace doesn't use these points: it comes from every fix's speed,
// per stroke.
const MIN_GPS_POINT_SPACING_MS = 950.0;
// Stroke limits of the firmware's SPM detector (main.py: SPM_MAX 50,
// MIN_SPM 14). A catch-to-catch gap outside them is not one stroke:
// a pause, or a catch the detector missed.
const MIN_STROKE_MS = Math.floor(60000 / 50);
const MAX_STROKE_MS = Math.floor(60000 / 14);

function parseCsvLine(line) {
    const fields = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                if (line[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                field += ch;
            }
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === ',') {
            fields.push(field);
            field = '';
        } else {
            field += ch;
        }
    }
    fields.push(field);
    return fields;
}

// Parses the mixed Pico log CSV. Returns {points, strokes}: the
// ordered, filtered GPS points used by the map/charts, and the
// strokes from the A rows' catches (see buildStrokes).
function loadLogFromCsvText(text) {
    const lines = text.split(/\r\n|\r|\n/).filter((line, i, arr) => !(i === arr.length - 1 && line === ''));
    if (lines.length === 0) {
        throw new Error('Empty CSV file.');
    }

    const header = parseCsvLine(lines[0]);
    if (header.length !== MIXED_HEADER.length || header.some((h, i) => h !== MIXED_HEADER[i])) {
        throw new Error('Unsupported CSV format. Expected the mixed Pico log header.');
    }

    const rawPoints = [];
    const catchUptimes = [];
    for (let rowIndex = 0; rowIndex < lines.length - 1; rowIndex++) {
        const fields = parseCsvLine(lines[rowIndex + 1]);
        const row = {};
        MIXED_HEADER.forEach((name, i) => { row[name] = fields[i]; });

        const recordType = (row.record_type || '').trim().toUpperCase();
        if (recordType === 'A') {
            if ((row.stroke_flag || '').trim() === '1') {
                catchUptimes.push(parseFloat(row.uptime_ms));
            }
            continue;
        }
        if (recordType !== 'G') {
            continue;
        }

        const lat = parseFloat(row.gps_lat);
        const lon = parseFloat(row.gps_lon);
        if (!isFinite(lat) || !isFinite(lon) || lat === 0 || lon === 0) {
            continue;
        }

        const timeValue = (parseFloat(row.time) || 0) * 1000.0;
        if (timeValue <= 0) {
            continue;
        }

        rawPoints.push({
            lat, lon,
            time: timeValue,
            index: rowIndex,
            speed_mps: parseFloat(row.speed_mps) || 0,
            spm: parseFloat(row.spm) || 0,
            uptime_ms: Math.trunc(parseFloat(row.uptime_ms) || 0),
            sats: row.sats || '',
            hdop: row.hdop || '',
            fix_quality: row.fix_quality || '',
            course_deg: row.course_deg || ''
        });
    }

    rawPoints.sort((a, b) => (a.time - b.time) || (a.index - b.index));
    const strokes = buildStrokes(rawPoints, catchUptimes);

    const orderedPoints = [];
    for (const point of rawPoints) {
        if (orderedPoints.length > 0) {
            const previous = orderedPoints[orderedPoints.length - 1];
            const deltaMs = point.time - previous.time;
            if (deltaMs < MIN_GPS_POINT_SPACING_MS) {
                continue;
            }

            const distanceM = haversine(previous.lat, previous.lon, point.lat, point.lon);
            const impliedSpeed = distanceM / (deltaMs / 1000.0);
            if (impliedSpeed > MAX_GPS_POINT_SPEED_MPS) {
                continue;
            }
        }

        if (orderedPoints.length > 0) {
            const previous = orderedPoints[orderedPoints.length - 1];
            if (previous.lat === point.lat && previous.lon === point.lon) {
                continue;
            }
        }

        orderedPoints.push(point);
    }

    return {points: orderedPoints, strokes};
}

// One stroke per pair of consecutive catches (A rows' stroke_flag)
// no further apart than the firmware's stroke limits: the mean of the
// GPS speed field over the fixes after the first catch, up to the
// second. Every fix counts, not just the ~1 s points: a whole stroke
// averages out the surge within it, and the speed field is far less
// noisy than position steps. Returns [{startTime, endTime, speed,
// pace}] in GPS ms, oldest first.
function buildStrokes(fixes, catchUptimes) {
    if (fixes.length < 2 || catchUptimes.length < 2) {
        return [];
    }
    // A catch's time on the GPS clock, between the G rows around it.
    const byUptime = fixes.slice().sort((a, b) => a.uptime_ms - b.uptime_ms);
    const gpsTimeAt = (uptimeMs) => {
        let lo = 0;
        let hi = byUptime.length - 1;
        if (uptimeMs <= byUptime[lo].uptime_ms) return byUptime[lo].time;
        if (uptimeMs >= byUptime[hi].uptime_ms) return byUptime[hi].time;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (byUptime[mid].uptime_ms <= uptimeMs) lo = mid; else hi = mid;
        }
        const a = byUptime[lo];
        const b = byUptime[hi];
        const span = b.uptime_ms - a.uptime_ms;
        return span > 0 ? a.time + (b.time - a.time) * (uptimeMs - a.uptime_ms) / span : a.time;
    };
    const catchTimes = catchUptimes.map(gpsTimeAt);

    const strokes = [];
    let first = 0; // first fix after the current stroke's start
    for (let k = 0; k + 1 < catchUptimes.length; k++) {
        const durationMs = catchUptimes[k + 1] - catchUptimes[k];
        if (durationMs < MIN_STROKE_MS || durationMs > MAX_STROKE_MS) {
            continue;
        }
        const start = catchTimes[k];
        const end = catchTimes[k + 1];
        while (first < fixes.length && fixes[first].time <= start) {
            first++;
        }
        let sum = 0;
        let count = 0;
        for (let i = first; i < fixes.length && fixes[i].time <= end; i++) {
            sum += fixes[i].speed_mps;
            count++;
        }
        if (count === 0 || sum <= 0) {
            continue;
        }
        const speed = sum / count;
        strokes.push({startTime: start, endTime: end, speed, pace: 500.0 / speed});
    }
    return strokes;
}

// Computes full statistics (distance, pace, SPM, pauses, percentiles)
// for a range of GPS points. Used both for the full-track stats
// (startIdx=0, endIdx=points.length-1) and for the current chart
// selection. Pace and speed (min/median/max, percentiles,
// distribution) are per stroke; the average is moving distance /
// moving time.
function analyzeSection(points, startIdx, endIdx, pauseThreshold) {
    if (pauseThreshold === null || pauseThreshold === undefined) {
        pauseThreshold = DEFAULT_PAUSE_THRESHOLD;
    }
    if (startIdx >= endIdx || startIdx < 0 || endIdx >= points.length) {
        return null;
    }

    const sectionPoints = points.slice(startIdx, endIdx + 1);
    if (sectionPoints.length < 2) {
        return null;
    }

    let totalDistance = 0.0;
    let movingDistance = 0.0;
    const spms = [];
    const cumulativeDistances = [0.0];
    const movingDistances = [0.0];
    const isPause = [false];

    for (let i = 0; i < sectionPoints.length - 1; i++) {
        const p1 = sectionPoints[i];
        const p2 = sectionPoints[i + 1];
        const dist = haversine(p1.lat, p1.lon, p2.lat, p2.lon);
        totalDistance += dist;
        cumulativeDistances.push(totalDistance);

        // Only tells pauses from rowing; pace and speed come per stroke.
        const timeDiff = (p2.time - p1.time) / 1000.0;
        const speed = timeDiff > 0 ? dist / timeDiff : 0.0;

        if (pauseThreshold !== null && speed < pauseThreshold) {
            isPause.push(true);
            movingDistances.push(movingDistances[movingDistances.length - 1]);
        } else {
            isPause.push(false);
            movingDistance += dist;
            movingDistances.push(movingDistance);
        }

        spms.push(p1.spm || 0.0);
    }

    const totalTime = sectionPoints.length ? (sectionPoints[sectionPoints.length - 1].time - sectionPoints[0].time) / 1000.0 : 0.0;
    let movingTime = 0.0;
    if (pauseThreshold === null) {
        movingTime = totalTime;
    } else {
        for (let i = 0; i < sectionPoints.length - 1; i++) {
            const segmentTime = (sectionPoints[i + 1].time - sectionPoints[i].time) / 1000.0;
            if (!isPause[i + 1]) {
                movingTime += segmentTime;
            }
        }
    }

    let pauseCount = 0;
    let inPause = false;
    for (let i = 1; i < isPause.length; i++) {
        if (isPause[i] && !inPause) {
            pauseCount++;
            inPause = true;
        } else if (!isPause[i]) {
            inPause = false;
        }
    }

    const pausePercentage = totalTime > 0 ? ((totalTime - movingTime) / totalTime) * 100.0 : 0.0;
    const avgSpeed = movingTime > 0 ? movingDistance / movingTime : 0.0;
    const avgPace = avgSpeed > 0 ? 500.0 / avgSpeed : 0.0;

    // The strokes whose middle falls in the section (points are
    // gpsPoints, the time base of allStrokes).
    const fromS = (sectionPoints[0].time - points[0].time) / 1000.0;
    const toS = (sectionPoints[sectionPoints.length - 1].time - points[0].time) / 1000.0;
    const sectionStrokes = allStrokes.filter(s => s.midS >= fromS && s.midS <= toS);
    const speeds = sectionStrokes.map(s => s.speed);
    const paces = sectionStrokes.map(s => s.pace);

    const validSpeeds = speeds.filter(s => s > 0);
    const validPaces = paces.filter(p => p > 0);
    const validSpms = spms.filter(s => s > 0);

    return {
        start_idx: startIdx,
        end_idx: endIdx,
        point_count: sectionPoints.length,
        total_distance: totalDistance,
        moving_distance: movingDistance,
        total_time: totalTime,
        moving_time: movingTime,
        avg_speed: avgSpeed,
        avg_pace: avgPace,
        min_speed: validSpeeds.length ? Math.min(...validSpeeds) : 0.0,
        max_speed: validSpeeds.length ? Math.max(...validSpeeds) : 0.0,
        min_pace: validPaces.length ? Math.min(...validPaces) : 0.0,
        max_pace: validPaces.length ? Math.max(...validPaces) : 0.0,
        median_speed: median(validSpeeds),
        median_pace: median(validPaces),
        speed_percentile_1: percentile(validSpeeds, 1),
        speed_percentile_99: percentile(validSpeeds, 99),
        pace_percentile_1: percentile(validPaces, 1),
        pace_percentile_99: percentile(validPaces, 99),
        avg_spm: validSpms.length ? validSpms.reduce((a, b) => a + b, 0) / validSpms.length : 0.0,
        min_spm: validSpms.length ? Math.min(...validSpms) : 0.0,
        max_spm: validSpms.length ? Math.max(...validSpms) : 0.0,
        median_spm: median(validSpms),
        spm_percentile_1: percentile(validSpms, 1),
        spm_percentile_99: percentile(validSpms, 99),
        pause_percentage: pausePercentage,
        pause_count: pauseCount,
        is_pause: isPause,
        start_lat: sectionPoints[0].lat,
        start_lon: sectionPoints[0].lon,
        end_lat: sectionPoints[sectionPoints.length - 1].lat,
        end_lon: sectionPoints[sectionPoints.length - 1].lon,
        speeds,
        paces,
        spms,
        cumulative_distances: cumulativeDistances,
        moving_distances: movingDistances
    };
}

function calculateCumulativeData() {
    cumulativeDistances = [0];
    cumulativeTimes = [0];
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
    }

    // Add last point
    cumulativeTimes.push(cumulativeTimes[cumulativeTimes.length - 1] +
        (gpsPoints[gpsPoints.length - 1].time - gpsPoints[gpsPoints.length - 2].time) / 1000.0);
}

// Puts each stroke on the session's axes: seconds since the first
// point (cumulativeTimes) and meters along the track at its middle.
// Also gives every track segment the pace of the stroke its middle
// falls in, for the map.
function placeStrokes(strokes) {
    allStrokes = [];
    segmentPaces = [];
    if (gpsPoints.length < 2) {
        return;
    }
    const t0 = gpsPoints[0].time;
    allStrokes = strokes.map((stroke, k) => {
        const startS = (stroke.startTime - t0) / 1000.0;
        const endS = (stroke.endTime - t0) / 1000.0;
        const midS = (startS + endS) / 2;
        return {
            startS, endS, midS,
            x: distanceAtTime(midS),
            speed: stroke.speed,
            pace: stroke.pace,
            // false after a pause or a missed catch: the charts break the line there
            followsPrevious: k > 0 && strokes[k - 1].endTime === stroke.startTime
        };
    });

    let k = 0;
    for (let i = 0; i < gpsPoints.length - 1; i++) {
        const mid = (cumulativeTimes[i] + cumulativeTimes[i + 1]) / 2;
        while (k < allStrokes.length && allStrokes[k].endS <= mid) {
            k++;
        }
        const inStroke = k < allStrokes.length && allStrokes[k].startS <= mid;
        segmentPaces.push(inStroke ? allStrokes[k].pace : 0);
    }
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
