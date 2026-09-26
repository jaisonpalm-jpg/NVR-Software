# Vision NVR

WS1-U1 shell for the VMS. The frontend is the baseline Vision NVR page with locked primary navigation. The API stores cameras in SQLite and probes the LAN for ONVIF devices. This unit does not authenticate to devices, open streams, or play video.

## Run locally

Requires Node.js 22 or newer. The API uses the built-in `node:sqlite` and `node:dgram` modules, so there are no packages to install.

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

## Discover ONVIF devices

`POST /api/onvif/discover` sends WS-Discovery Probe datagrams (SOAP over UDP) and waits for ProbeMatches.

- Multicast group: `239.255.255.250`
- Port: `3702`
- Probe types: `dn:NetworkVideoTransmitter` and `tds:Device`
- Default wait: 2 seconds (`timeoutMs` from 100 through 5000)

An empty network is a successful result: `ok: true`, `implemented: true`, and `devices: []`. Discovery does not add rows to the camera store.

```bash
curl -sS -X POST http://127.0.0.1:8787/api/onvif/discover \
  -H 'content-type: application/json' \
  -d '{}'
```

Optional unicast probe of one host. `port` is the WS-Discovery UDP port and defaults to `3702`. This is not an ONVIF HTTP login and it does not call GetDeviceInformation.

```bash
curl -sS -X POST http://127.0.0.1:8787/api/onvif/discover \
  -H 'content-type: application/json' \
  -d '{"host":"192.168.1.64","port":3702,"timeoutMs":2000}'
```

Each device, when a camera answers, includes `address`, ONVIF `port` when the XAddr has one, `name`, `manufacturer`, and `model` when those scopes are present, plus a `probe` object (`endpoint`, `types`, `metadataVersion`, `xaddrs`, `scopes`). Username, password, and any other body fields are ignored. They are not logged, stored, or copied into the JSON. URL userinfo is stripped from XAddrs and scopes.

The Cameras page button **Discover ONVIF devices** calls this endpoint with an empty body and lists the result. Saving a camera is a separate name / site / group action.

### Network notes

The process must be allowed to send and receive UDP on the LAN interface. Replies come back to the ephemeral source port, so a host firewall has to allow that inbound UDP. Linux containers often drop multicast unless they use the host network. macOS local-network privacy can block packaged apps; a normal Node process on a developer machine can send the probe.

This cloud agent VM has no route to a camera LAN. The probe still runs. With no answers it returns `devices: []`.

IPv6 discovery and an authenticated HTTP device-service call are later units.

## API

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/cameras` | JSON array. Empty until a camera is saved. |
| `POST` | `/api/cameras` | Saves `name`, `site`, and `group`. Status is `unknown`. |
| `GET` | `/api/cameras/:id` | Public camera record, or `404`. |
| `GET` | `/api/cameras/:id/stream` | `{ "stream": null, "delivery": "unavailable" }`. No stream URL. |
| `POST` | `/api/onvif/discover` | Live WS-Discovery probe. `implemented: true`. `devices` is an array. |
| `POST` | `/api/onvif/test` | Checks reported as `not_run`. |

Example:

```bash
curl -sS http://127.0.0.1:8787/api/cameras
curl -sS -X POST http://127.0.0.1:8787/api/onvif/discover -H 'content-type: application/json' -d '{}'
curl -sS -X POST http://127.0.0.1:8787/api/onvif/test -H 'content-type: application/json' -d '{}'
```

Saved cameras accept a display name, site, and group only. The store drops every other field. Text that contains URL userinfo is stored without that userinfo. Responses never include a stream URL.

`npm test` checks the empty list, the discover envelope, a scripted ProbeMatches reply, the real socket path, and that secret-bearing fields are not stored, logged, or returned.

## UI scope

Primary navigation is **Live View**, **Playback**, **Cameras**, **Storage**, and **Settings**. Live tiles are the existing visual placeholders. Playback, Storage, and Settings are shells. Camera records added in the UI show under Cameras; they do not start video. Discover results are not saved.
