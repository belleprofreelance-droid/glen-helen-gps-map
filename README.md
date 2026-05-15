# Glen Helen Personal GPS Map

Static GitHub Pages build for a personal Glen Helen GPS map.

## Current status

This repository contains the HTML/CSS/JS and KMZ-derived config for the Glen Helen personal GPS map.

The app uses the KMZ-extracted image dimensions:

- Width: `3311 px`
- Height: `5117 px`

The georeference source is the KMZ GroundOverlay LatLonBox. This is an initial alignment only and is not field calibrated.

## Required manual asset

The binary map image still needs to be uploaded to this path:

```text
assets/map/glen-helen-map-web.jpg
```

Use the prepared project zip from ChatGPT and upload that JPG through GitHub's browser upload interface.

## Calibration rule

Do not invent GPS coordinates or calibration points. `data/calibration-points.json` intentionally remains empty until field data is collected.

## Deploy

Enable GitHub Pages:

```text
Settings → Pages → Deploy from a branch → main → /root → Save
```

Expected URL:

```text
https://belleprofreelance-droid.github.io/glen-helen-gps-map/
```
