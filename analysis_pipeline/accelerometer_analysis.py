"""
Interactive accelerometer magnitude viewer for the mixed Pico log format.

This script loads only the `A` rows from the new mixed CSV logs, plots the
acceleration magnitude, and lets you drag on the plot to change the analysis
range.
"""

from __future__ import annotations

import argparse
import csv
import math

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.widgets import SpanSelector
from scipy.signal import find_peaks


DEFAULT_CSV = "test_data/rowing_log011.csv"


def _to_float(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _to_int(value, default=0):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def load_accel_magnitude(csv_file):
    sample_indices = []
    uptime_ms = []
    magnitude = []

    print(f"Loading data from {csv_file}...")
    with open(csv_file, "r", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if (row.get("record_type") or "").strip().upper() != "A":
                continue

            ax = _to_float(row.get("accel_x"), 0.0)
            ay = _to_float(row.get("accel_y"), 0.0)
            az = _to_float(row.get("accel_z"), 0.0)
            mag = math.sqrt(ax * ax + ay * ay + az * az)

            sample_indices.append(len(sample_indices))
            uptime_ms.append(_to_int(row.get("uptime_ms"), len(sample_indices) - 1))
            magnitude.append(mag)

    if not magnitude:
        raise ValueError("No acceleration rows found. This script expects the mixed Pico log format.")

    return np.asarray(sample_indices), np.asarray(uptime_ms), np.asarray(magnitude)


def summarise_range(uptime, mag, start_idx, end_idx):
    segment = mag[start_idx : end_idx + 1]
    segment_uptime = uptime[start_idx : end_idx + 1]

    duration_s = (segment_uptime[-1] - segment_uptime[0]) / 1000.0 if len(segment_uptime) > 1 else 0.0
    mean_value = float(np.mean(segment))
    std_value = float(np.std(segment))
    min_value = float(np.min(segment))
    max_value = float(np.max(segment))

    if len(segment) >= 5:
        smoothed = np.convolve(segment, np.ones(5) / 5.0, mode="same")
        prominence = max(float(np.std(smoothed)) * 0.35, 0.2)
        peaks, _ = find_peaks(smoothed, prominence=prominence)
    else:
        peaks = np.array([])

    strokes = len(peaks)
    spm = (strokes / duration_s) * 60.0 if duration_s > 0 else 0.0

    return {
        "start_idx": start_idx,
        "end_idx": end_idx,
        "start_uptime": int(segment_uptime[0]),
        "end_uptime": int(segment_uptime[-1]),
        "duration_s": duration_s,
        "mean": mean_value,
        "std": std_value,
        "min": min_value,
        "max": max_value,
        "strokes": strokes,
        "spm": spm,
    }


def main():
    parser = argparse.ArgumentParser(description="Interactive acceleration magnitude viewer for mixed Pico logs.")
    parser.add_argument("--csv", default=DEFAULT_CSV, help="Path to a mixed log CSV file")
    parser.add_argument("--start", type=int, default=0, help="Initial start index")
    parser.add_argument("--end", type=int, default=None, help="Initial end index")
    args = parser.parse_args()

    sample_indices, uptime_ms, magnitude = load_accel_magnitude(args.csv)
    last_index = len(magnitude) - 1

    start_idx = max(0, min(args.start, last_index))
    end_idx = last_index if args.end is None else max(0, min(args.end, last_index))
    if end_idx < start_idx:
        start_idx, end_idx = end_idx, start_idx

    print(f"Loaded {len(magnitude)} acceleration rows")
    print("Drag across the plot to change the analysis range.")

    fig, (ax_full, ax_zoom) = plt.subplots(
        2,
        1,
        figsize=(14, 9),
        gridspec_kw={"height_ratios": [2.2, 1.4]},
    )

    ax_full.plot(sample_indices, magnitude, color="#f28e2b", linewidth=1.2, label="Acceleration magnitude")
    ax_full.set_xlabel("Acceleration sample index")
    ax_full.set_ylabel("Acceleration magnitude (m/s²)")
    ax_full.set_title("Acceleration Magnitude - drag on the plot to choose the analysis range")
    ax_full.grid(True, alpha=0.25)

    selected_span = ax_full.axvspan(start_idx, end_idx, color="#4e79a7", alpha=0.18)
    left_line = ax_full.axvline(start_idx, color="#4e79a7", linestyle="--", linewidth=1.2)
    right_line = ax_full.axvline(end_idx, color="#4e79a7", linestyle="--", linewidth=1.2)

    stats_box = ax_full.text(
        0.02,
        0.98,
        "",
        transform=ax_full.transAxes,
        va="top",
        ha="left",
        bbox=dict(boxstyle="round", facecolor="white", alpha=0.85),
    )

    zoom_line, = ax_zoom.plot([], [], color="#59a14f", linewidth=1.4, label="Selected range")
    ax_zoom.set_xlabel("Acceleration sample index")
    ax_zoom.set_ylabel("Acceleration magnitude (m/s²)")
    ax_zoom.set_title("Selected Range")
    ax_zoom.grid(True, alpha=0.25)
    ax_zoom.legend(loc="upper right")

    def update_zoom_plot(new_start, new_end):
        segment_x = sample_indices[new_start : new_end + 1]
        segment_y = magnitude[new_start : new_end + 1]
        zoom_line.set_data(segment_x, segment_y)

        if len(segment_x) == 1:
            pad = 1
            ax_zoom.set_xlim(segment_x[0] - pad, segment_x[0] + pad)
        else:
            ax_zoom.set_xlim(segment_x[0], segment_x[-1])

        y_min = float(np.min(segment_y))
        y_max = float(np.max(segment_y))
        y_pad = max((y_max - y_min) * 0.1, 0.25)
        ax_zoom.set_ylim(y_min - y_pad, y_max + y_pad)

    def update_display(new_start, new_end):
        nonlocal selected_span, left_line, right_line

        new_start = max(0, min(int(round(new_start)), last_index))
        new_end = max(0, min(int(round(new_end)), last_index))
        if new_end < new_start:
            new_start, new_end = new_end, new_start

        selected_span.remove()
        left_line.remove()
        right_line.remove()

        selected_span = ax_full.axvspan(new_start, new_end, color="#4e79a7", alpha=0.18)
        left_line = ax_full.axvline(new_start, color="#4e79a7", linestyle="--", linewidth=1.2)
        right_line = ax_full.axvline(new_end, color="#4e79a7", linestyle="--", linewidth=1.2)

        update_zoom_plot(new_start, new_end)

        summary = summarise_range(uptime_ms, magnitude, new_start, new_end)
        stats_box.set_text(
            "Range: {start_idx} - {end_idx}\n"
            "Uptime: {start_uptime} - {end_uptime} ms\n"
            "Duration: {duration_s:.2f} s\n"
            "Mean: {mean:.3f} m/s²\n"
            "Std: {std:.3f} m/s²\n"
            "Min/Max: {min:.3f} / {max:.3f} m/s²\n"
            "Peaks: {strokes} | Est. SPM: {spm:.1f}".format(**summary)
        )

        print(
            f"Range {summary['start_idx']}-{summary['end_idx']} | "
            f"uptime {summary['start_uptime']}-{summary['end_uptime']} ms | "
            f"duration {summary['duration_s']:.2f}s | "
            f"mean {summary['mean']:.3f} | std {summary['std']:.3f} | "
            f"peaks {summary['strokes']} | spm {summary['spm']:.1f}"
        )

        fig.canvas.draw_idle()

    def on_select(xmin, xmax):
        update_display(xmin, xmax)

    selector = SpanSelector(
        ax_full,
        on_select,
        direction="horizontal",
        useblit=True,
        props=dict(alpha=0.2, facecolor="#4e79a7"),
        interactive=True,
        drag_from_anywhere=True,
    )

    update_display(start_idx, end_idx)
    ax_full.legend(loc="lower right")
    plt.tight_layout()
    plt.show()


if __name__ == "__main__":
    main()
