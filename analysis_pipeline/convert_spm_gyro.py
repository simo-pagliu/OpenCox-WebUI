"""Recompute the spm column using gyro_x-based catch detection.

Background: PicoStrokeDetector (accel-magnitude based) shows two similarly
sized deceleration events per stroke, which turned out to make it unreliable
for telling strokes apart -- see the stroke-review discussion this script
came out of. gyro_x (boat pitch rate) instead shows one big, sharp,
consistently-dominant peak per stroke, validated against the accelerometer's
own deceleration dip and against manually labeled strokes across two
sessions. PicoGyroSpmDetector (in the firmware repo) implements catch
detection from that signal; this script replays it over an existing mixed
log's A rows and overwrites the spm column on the G and S rows with the
result, in file order, exactly the way the firmware would have computed it
live -- so a G row's corrected spm reflects the most recently completed
stroke as of that row, same as log_gps_row(get_spm(), ...) does on-device.

Everything else (stroke_flag, catch_duration_ms, exit_duration_ms, shape_*)
is left untouched: those still come from the accel-based detector, and
whether gyro_x's small mid-cycle peak is "catch" or "exit" is a separate,
not-yet-decided question. Only the spm column changes.

Requires the OpenCox-RP2350 firmware repo checked out alongside this one (it
supplies PicoGyroSpmDetector), or OPENCOX_FIRMWARE_DIR pointing at a checkout.

Usage (from the repo root):
    python -m analysis_pipeline.convert_spm_gyro --input rowing_log003.csv --output rowing_log003_spm_fixed.csv
    python -m analysis_pipeline.convert_spm_gyro --input-dir . --output-dir spm_fixed --pattern "rowing_log*.csv"
"""

import argparse
import csv
import glob
import os
import sys

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

# PicoGyroSpmDetector lives in the firmware repository, which is separate
# from this one since the OpenCox split. Both the umbrella-submodule layout
# and plain side-by-side clones leave it as a sibling of this repo's root.
_FIRMWARE_CANDIDATES = (
    os.environ.get('OPENCOX_FIRMWARE_DIR'),
    os.path.join(os.path.dirname(_REPO_ROOT), 'OpenCox-RP2350'),
)
for _candidate in _FIRMWARE_CANDIDATES:
    if _candidate and os.path.isfile(os.path.join(_candidate, 'gyro_stroke_detection.py')):
        if _candidate not in sys.path:
            sys.path.insert(0, _candidate)
        break
else:
    raise SystemExit(
        "Cannot find gyro_stroke_detection.py from the OpenCox-RP2350 firmware repo.\n"
        "Clone it alongside this repository:\n"
        "    git clone https://github.com/simo-pagliu/OpenCox-RP2350.git "
        + os.path.join(os.path.dirname(_REPO_ROOT), 'OpenCox-RP2350') + "\n"
        "or point OPENCOX_FIRMWARE_DIR at an existing checkout."
    )

from analysis_pipeline.process_csv import MIXED_HEADER_COLUMNS  # noqa: E402
from gyro_stroke_detection import PicoGyroSpmDetector  # noqa: E402


DEFAULT_MIN_SPM = 12
DEFAULT_MAX_SPM = 50  # see PicoGyroSpmDetector's max_spm docstring note


def _to_float(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def convert_rows(rows, min_spm=DEFAULT_MIN_SPM, max_spm=DEFAULT_MAX_SPM):
    """Replay A rows' gyro_x through PicoGyroSpmDetector, overwriting spm on G/S rows."""
    detector = PicoGyroSpmDetector(min_spm=min_spm, max_spm=max_spm)

    catches = 0
    out_rows = []
    for row in rows:
        out_row = {col: row.get(col, '') for col in MIXED_HEADER_COLUMNS}
        record_type = (row.get('record_type') or '').strip().upper()

        if record_type == 'A':
            uptime_ms = int(_to_float(row.get('uptime_ms'), 0.0))
            gyro_x = _to_float(row.get('gyro_x'))
            if detector.update(gyro_x, uptime_ms):
                catches += 1
            # No external timeout reset here (unlike PicoStrokeDetector):
            # _handle_catch already clears stroke_intervals/current_spm the
            # moment a too-long gap is seen, and the adaptive big/small peak
            # levels should persist across a brief pause rather than being
            # wiped and forced to re-bootstrap on every stop.
        elif record_type in ('G', 'S'):
            out_row['spm'] = '%.2f' % detector.get_spm()

        out_rows.append(out_row)

    return out_rows, catches


def convert_file(input_path, output_path, min_spm=DEFAULT_MIN_SPM, max_spm=DEFAULT_MAX_SPM):
    with open(input_path, 'r', newline='') as f:
        reader = csv.DictReader(f)
        rows = list(reader)

    out_rows, catches = convert_rows(rows, min_spm=min_spm, max_spm=max_spm)

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
    parser.add_argument('--input-dir', default='.', help='Directory of mixed CSV logs (default: repo root)')
    parser.add_argument('--output-dir', default='spm_fixed', help='Directory for corrected logs (default: spm_fixed)')
    parser.add_argument('--pattern', default='rowing_log*.csv', help='Glob pattern within --input-dir')
    parser.add_argument('--min-spm', type=int, default=DEFAULT_MIN_SPM)
    parser.add_argument('--max-spm', type=int, default=DEFAULT_MAX_SPM)
    args = parser.parse_args()

    if args.input:
        if not args.output:
            parser.error('--output is required when --input is set')
        rows, catches = convert_file(args.input, args.output, args.min_spm, args.max_spm)
        print(f"{args.input} -> {args.output}: {rows} rows, {catches} catches")
        return

    input_paths = sorted(glob.glob(os.path.join(args.input_dir, args.pattern)))
    if not input_paths:
        print(f"No files matching {args.pattern} in {args.input_dir}")
        return

    for input_path in input_paths:
        output_path = os.path.join(args.output_dir, os.path.basename(input_path))
        rows, catches = convert_file(input_path, output_path, args.min_spm, args.max_spm)
        print(f"{input_path} -> {output_path}: {rows} rows, {catches} catches")


if __name__ == '__main__':
    main()
