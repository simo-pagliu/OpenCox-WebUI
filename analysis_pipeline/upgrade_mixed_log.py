"""Backfill catch/exit duration and stroke-shape columns onto legacy mixed logs.

Local-testing utility only: not wired into the webapp or analysis_pipeline's
normal processing flow (app.py / process_csv.py). Logs recorded before
catch_duration_ms/exit_duration_ms/shape_0..shape_4 were added to the mixed
CSV format (e.g. test_data/*.csv) don't have those columns, so the webapp's
new stroke-shape/duration charts have nothing to show for them.

This replays each A row's accelerometer stream through the current
PicoStrokeDetector to regenerate stroke_flag together with the new columns
in one consistent pass -- reusing the old file's stroke_flag values would
leave them out of sync with catch_duration_ms/shape_*, since those all
depend on the same detector run producing the same catch/exit decisions.
G/other rows are copied through unchanged aside from padding the new columns
with blanks.

Requires the OpenCox-RP2350 firmware repo checked out alongside this one (it
supplies PicoStrokeDetector), or OPENCOX_FIRMWARE_DIR pointing at a checkout.

Usage (from the repo root):
    python -m analysis_pipeline.upgrade_mixed_log
    python -m analysis_pipeline.upgrade_mixed_log --input-dir test_data --output-dir test_data_upgraded
    python -m analysis_pipeline.upgrade_mixed_log --input test_data/rowing_log001.csv --output /tmp/out.csv
"""

import argparse
import csv
import glob
import os
import sys

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

# PicoStrokeDetector lives in the firmware repository, which is separate from
# this one since the OpenCox split. Both the umbrella-submodule layout and
# plain side-by-side clones leave it as a sibling of this repo's root.
_FIRMWARE_CANDIDATES = (
    os.environ.get('OPENCOX_FIRMWARE_DIR'),
    os.path.join(os.path.dirname(_REPO_ROOT), 'OpenCox-RP2350'),
)
for _candidate in _FIRMWARE_CANDIDATES:
    if _candidate and os.path.isfile(os.path.join(_candidate, 'stroke_detection.py')):
        if _candidate not in sys.path:
            sys.path.insert(0, _candidate)
        break
else:
    raise SystemExit(
        "Cannot find stroke_detection.py from the OpenCox-RP2350 firmware repo.\n"
        "Clone it alongside this repository:\n"
        "    git clone https://github.com/simo-pagliu/OpenCox-RP2350.git "
        + os.path.join(os.path.dirname(_REPO_ROOT), 'OpenCox-RP2350') + "\n"
        "or point OPENCOX_FIRMWARE_DIR at an existing checkout."
    )

from analysis_pipeline.process_csv import MIXED_HEADER_COLUMNS  # noqa: E402
from stroke_detection import PicoStrokeDetector  # noqa: E402


NEW_COLUMNS = ['catch_duration_ms', 'exit_duration_ms', 'shape_0', 'shape_1', 'shape_2', 'shape_3', 'shape_4']
SHAPE_POINT_COUNT = 5

DEFAULT_MIN_SPM = 14
DEFAULT_MAX_SPM = 55


def _to_float(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def upgrade_rows(rows, min_spm=DEFAULT_MIN_SPM, max_spm=DEFAULT_MAX_SPM):
    """Replay A rows through PicoStrokeDetector, returning rows keyed by MIXED_HEADER_COLUMNS."""
    detector = PicoStrokeDetector(min_spm=min_spm, max_spm=max_spm)
    stroke_max_interval_ms = 60000.0 / min_spm

    catches = 0
    out_rows = []
    for row in rows:
        out_row = {col: row.get(col, '') for col in MIXED_HEADER_COLUMNS if col not in NEW_COLUMNS}
        for col in NEW_COLUMNS:
            out_row[col] = ''

        if (row.get('record_type') or '').strip().upper() != 'A':
            out_rows.append(out_row)
            continue

        uptime_ms = int(_to_float(row.get('uptime_ms'), 0.0))
        accel_x = _to_float(row.get('accel_x'))
        accel_y = _to_float(row.get('accel_y'))
        accel_z = _to_float(row.get('accel_z'))

        catch = detector.detect_stroke(accel_x, accel_y, accel_z, uptime_ms)
        out_row['stroke_flag'] = '1' if catch else '0'
        if catch:
            catches += 1

        if detector.catch_duration_available():
            out_row['catch_duration_ms'] = '%d' % detector.get_catch_duration_ms()
        if detector.exit_duration_available():
            out_row['exit_duration_ms'] = '%d' % detector.get_exit_duration_ms()
        if detector.stroke_shape_available():
            shape = detector.get_stroke_shape()
            for i in range(SHAPE_POINT_COUNT):
                out_row['shape_%d' % i] = '%.4f' % shape[i]

        # Mirrors main.py's stroke-timeout reset, applied per accel sample
        # here instead of per FIFO batch (finer-grained, same effect).
        if detector.last_stroke_time_ms > 0 and uptime_ms - detector.last_stroke_time_ms > stroke_max_interval_ms:
            detector.reset()

        out_rows.append(out_row)

    return out_rows, catches


def upgrade_file(input_path, output_path, min_spm=DEFAULT_MIN_SPM, max_spm=DEFAULT_MAX_SPM):
    with open(input_path, 'r', newline='') as f:
        reader = csv.DictReader(f)
        rows = list(reader)

    out_rows, catches = upgrade_rows(rows, min_spm=min_spm, max_spm=max_spm)

    os.makedirs(os.path.dirname(output_path) or '.', exist_ok=True)
    with open(output_path, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=MIXED_HEADER_COLUMNS)
        writer.writeheader()
        writer.writerows(out_rows)

    return len(out_rows), catches


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--input', help='Single input CSV file (overrides --input-dir)')
    parser.add_argument('--output', help='Output path for --input (required if --input is set)')
    parser.add_argument('--input-dir', default='test_data', help='Directory of legacy CSV logs (default: test_data)')
    parser.add_argument('--output-dir', default='test_data_upgraded', help='Directory for upgraded logs (default: test_data_upgraded)')
    parser.add_argument('--pattern', default='*.csv', help='Glob pattern within --input-dir (default: *.csv)')
    parser.add_argument('--min-spm', type=int, default=DEFAULT_MIN_SPM)
    parser.add_argument('--max-spm', type=int, default=DEFAULT_MAX_SPM)
    args = parser.parse_args()

    if args.input:
        if not args.output:
            parser.error('--output is required when --input is set')
        rows, catches = upgrade_file(args.input, args.output, args.min_spm, args.max_spm)
        print(f"{args.input} -> {args.output}: {rows} rows, {catches} catches")
        return

    input_paths = sorted(glob.glob(os.path.join(args.input_dir, args.pattern)))
    if not input_paths:
        print(f"No files matching {args.pattern} in {args.input_dir}")
        return

    for input_path in input_paths:
        output_path = os.path.join(args.output_dir, os.path.basename(input_path))
        rows, catches = upgrade_file(input_path, output_path, args.min_spm, args.max_spm)
        print(f"{input_path} -> {output_path}: {rows} rows, {catches} catches")


if __name__ == '__main__':
    main()
