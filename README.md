# Vision NVR

WS1-U0 shell for the VMS. The frontend is the baseline Vision NVR page with locked primary navigation. The API is a local stub in front of a SQLite camera store. This unit does not discover cameras, open streams, or play video.

## Run locally

Requires Node.js 22 or newer. The API uses the built-in `node:sqlite` module, so there are no packages to install.

```bash
npm start
```

One process serves both:

- Frontend: http://127.0.0.1:8787
- API: http://127.0.0.1:8787/api/cameras

`npm run api` and `npm run frontend` start that same process. Open the frontend in a browser at the URL above; do not open `index.html` as a file, or the API calls will have nowhere to go.

Optional environment variables:

- `PORT` — listen port, default `8787`
- `VMS_DB_PATH` — SQLite file, default `data/vms.sqlite`

The database file is created on first start and is gitignored.

## API

| Method | Path | Stub behavior |
| --- | --- | --- |
| `GET` | `/api/cameras` | JSON array. Empty until a camera is saved. |
| `POST` | `/api/cameras` | Saves `name`, `site`, and `group`. Status is `unknown`. |
| `GET` | `/api/cameras/:id` | Public camera record, or `404`. |
| `GET` | `/api/cameras/:id/stream` | `{ "stream": null, "delivery": "unavailable" }`. No stream URL. |
| `POST` | `/api/onvif/discover` | `{ "ok": true, "devices": [] }` and `implemented: false`. |
| `POST` | `/api/onvif/test` | Checks reported as `not_run`. |

Example:

```bash
curl -sS http://127.0.0.1:8787/api/cameras
curl -sS -X POST http://127.0.0.1:8787/api/onvif/discover -H 'content-type: application/json' -d '{}'
curl -sS -X POST http://127.0.0.1:8787/api/onvif/test -H 'content-type: application/json' -d '{}'
```

Saved cameras accept a display name, site, and group only. The store drops every other field. Text that contains URL userinfo is stored without that userinfo. Responses never include a stream URL.

`npm test` checks the empty list, the discover envelope, and that secret-bearing fields are not stored or returned.

## UI scope

Primary navigation is **Live View**, **Playback**, **Cameras**, **Storage**, and **Settings**. Live tiles are the existing visual placeholders. Playback, Storage, and Settings are shells. Camera records added in the UI show under Cameras; they do not start video.
