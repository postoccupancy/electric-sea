# Resident Frequency local recorder

The recorder runs on the Mac, connects directly to the rf-router WebSocket,
and writes scalar `osc/*` samples to hourly Parquet files. Binary PCM is ignored.

Open the controls at:

```text
http://127.0.0.1:3010
```

Recording is stopped by default. Opening or closing the control page does not
change recording state.

## Storage

The default directory is:

```text
~/Resident Frequency Recordings/
```

Files are grouped by source:

```text
electric-sky/2026-07-30_23.parquet
indoor-sky/2026-07-30_23.parquet
```

The default ceiling is 20 GiB and the recorder also preserves at least 8 GiB of
free disk space. It stops safely at either limit; it never deletes old recordings.

Each row contains:

- `device`
- `source`
- `parameter`
- `unit`
- `sequence`
- `timestamp_us` (source/device acquisition time)
- `received_at_us` (Mac wall-clock arrival time)
- `value`

Files use Snappy column compression. The `.inprogress` suffix is retained until
the hourly file is closed cleanly.

## Configuration

These environment variables can be added to the LaunchAgent if needed:

```text
RF_ROUTER_URL=wss://adrian-pi:3000
RF_RECORDER_PORT=3010
RF_RECORDING_DIR=~/Resident Frequency Recordings
RF_RECORDING_MAX_BYTES=21474836480
RF_RECORDING_MIN_FREE_BYTES=8589934592
```

Re-run `./install-macos.sh` after moving this repository, because the LaunchAgent
contains absolute paths. The installer copies the runtime to
`~/Library/Application Support/ResidentFrequency/recorder` so launchd does not
need permission to access the source repository under `~/Documents`.
