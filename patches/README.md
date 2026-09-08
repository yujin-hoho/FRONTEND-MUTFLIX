# Audio transcode buffering

`audio-transcode-buffering.patch` tracks the backend changes applied to
`../serverUtama.py`, which lives outside this Git repository. Deploy that backend
file together with the frontend player changes for the full improvement.

The backend keeps video stream copy and AAC stereo at the existing bitrate. MP4
fragments are capped at one second, mux interleaving is capped at one second, and
output is flushed promptly. Disconnect cleanup terminates/reaps FFmpeg and releases
the concurrency slot exactly once, including disconnects before the first read.
The response uses Flask's normal streaming iterator so its close callback runs.

The player reuses downloaded, seekable data for nearby seeks, accounting for the
transcode timeline offset. It closes replaced media requests and keeps transcode
playback from falling back to an incompatible original audio track on a stall.

Validation (2026-09-08):

- Frontend production build passed; all 18 frontend unit tests passed.
- Five backend route tests passed using Flask's WSGI response iterator.
- Lint passed on changed frontend files. Full lint reports existing errors in
  `App.jsx` and `AdminCatalogEditPage.jsx`.
- FFmpeg 8.1.2 synthetic test: 12 seconds of H.264 at 25 fps with 10-second keyframe
  spacing, plus AC-3 audio. Both original and updated route commands consumed the
  same local input with `-re` to simulate real-time arrival.
- First MP4 media data: **9.593 s before / 0.578 s after**. Fragment count: 2 / 12.
  Output size: 1,247,238 / 1,248,370 bytes. Both outputs decoded without errors and
  had identical video/audio durations (12.021375 / 12.016 seconds).

These are local synthetic results, not a production Google Drive throughput or
browser playback benchmark. The backend and frontend have not been deployed.

Run tests from this repository root (Python environment needs Flask):

```sh
python tests/test_audio_transcode.py ../serverUtama.py
node --test frontend/src/utils/*.test.js
npm --prefix frontend run build
```

FFmpeg option reference: https://ffmpeg.org/ffmpeg-formats.html
Flask response cleanup reference:
https://werkzeug.palletsprojects.com/en/stable/wrappers/#werkzeug.wrappers.Response.call_on_close
