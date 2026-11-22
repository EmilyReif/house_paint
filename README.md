# House Paint Preview

Pick siding / trim / accent colors and see them on the house.

**Live:** https://emilyreif.com/house_paint/

```sh
python3 -m http.server 8000 --bind 127.0.0.1
# open http://127.0.0.1:8000
```

(It has to be served over http; browsers block reading canvas pixels from `file://`.)

- `images/house.jpeg` is the photo.
- `images/mask.png`: red = siding, green = trim, blue = accents, black = leave alone. It's already
  aligned to the photo (2× its resolution). It's built from `images/mask_original.jpeg` by
  `node tools/edit_mask.js` (macOS; uses `sips`), which fixes the windows, the porch swing, the stairs
  and a stray blob, then applies the alignment warp in `tools/mask_warp.json`. You can also edit the PNG by hand.
- `images/house2.png` + `images/mask2.png`: the back of the house, shown next to the front.
  `mask2.png` is built from `images/mask2_original.jpeg` by `node tools/edit_mask2.js`. That script fixes the
  horizontal stretch and offset, blacks out the grass, bushes, roof and wires, makes window glass black
  and the sashes/muntins accent, and blacks out the dish, skylight and stair railing.
- `palettes.js` holds the preset combos.

Drag the black line on either photo to reveal the original to its left (both photos move together).

Paint is shaded from the photo: each pixel's color is scaled by its brightness relative to that region's typical
brightness (raised to `SHADING` = 1.5 in `app.js`).

**Formula** (side panel, `formula.js`) is one circular control:
- **Outer grey line**: drag anywhere on it to rotate all three hues together (or focus it and use the arrow keys).
- **Color ring**: has **S**iding, **T**rim and **A**ccent dots. Click a dot to select it, and drag it to change just that hue.
- **Square in the middle**: lightness (up) × saturation (right). All three dots show; the selected one is editable, and clicking a faded one selects it (the square switches to that dot's hue).
- **Hues** (right column): snap T and A into common hue relationships with S.
- **Lightness** (left column): set siding, trim and accent to light, medium or dark. The current level (and the matching hue formula, if any) is shown in white.

It works in OKLCH, so equal lightness looks equal across hues, and it edits the same three colors as everything else.

**Pick colors from a photo** (`reference.js`): drop a photo of any house onto the page, or click the box under the
formula circle. Drag the **S** / **T** / **A** pins onto its siding, trim and accent. Each pin averages a small patch
under it and sets that color. Scroll or pinch to zoom, drag the photo to pan, and double-click to reset. The photo stays
in your browser and is never uploaded.
