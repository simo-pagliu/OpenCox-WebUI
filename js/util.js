// Small helpers used by the other scripts: debouncing, clamping, number and
// time formatting, median and percentile.

function median(values) {
    if (!values.length) return 0.0;
    const sorted = values.slice().sort((a, b) => a - b);
    const n = sorted.length;
    if (n % 2) return sorted[Math.floor(n / 2)];
    return (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function percentile(values, pct) {
    if (!values.length) return 0.0;
    const sorted = values.slice().sort((a, b) => a - b);
    const k = (sorted.length - 1) * (pct / 100);
    const f = Math.floor(k);
    const c = Math.ceil(k);
    if (f === c) return sorted[k];
    return sorted[f] * (c - k) + sorted[c] * (k - f);
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
