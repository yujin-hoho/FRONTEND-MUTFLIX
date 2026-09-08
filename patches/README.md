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

## Subtitle timeline and module loading follow-up

The player now resolves the actual transcode keyframe timestamp for resume and
audio switches as well as regular seeks. Previously these paths assumed the
requested seek timestamp was the fragment origin, moving the subtitle clock ahead
by the keyframe preroll. A pending or malformed server timestamp is retried and
reported as an error rather than silently used as an offset. Buffered seeks still
reuse the current stream and its confirmed offset.

`frontend-module-routing.patch` tracks the additional changes applied to the local
backend: missing assets return 404 instead of `index.html`, HTML revalidates, and
the service worker is served with `no-store`. Vercel has matching routing/cache
rules and explicitly builds the `dist` output. The service worker cache is bumped
to v4 and rejects HTML responses for asset requests. A removed lazy module can
trigger one reload per build/tab, without a reload loop.

Validation: 33 frontend tests, four backend routing tests, the production build,
and lint on changed frontend files passed. Tests cover long-keyframe timeline
offsets, zero offsets, unresolved probes, poisoned asset caches, missing modules,
JavaScript MIME types, client routes, and bounded chunk reloads.

For Vercel use `frontend` as the project's Root Directory. For Flask hosting,
publish the contents of `frontend/dist` into the backend's `dist` directory.
Deploy frontend and backend together, then reload existing tabs to activate the
new worker. Production playback has not been verified without the failing site
and asset URLs.

```sh
python tests/test_frontend_routes.py ../serverUtama.py
```

References: [Vite load error handling](https://vite.dev/guide/build#load-error-handling),
[Vercel routing configuration](https://vercel.com/docs/project-configuration/vercel-json).
