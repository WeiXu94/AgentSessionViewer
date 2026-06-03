# Icon root-cause lesson

## Lesson

Fix the source of a fresh install. Do not patch around legacy state, cache behavior, or runtime overrides when the user wants a clean package/install to be correct.

For app icons, the correct target is the packaged asset and bundle metadata:

- macOS app icon: `electron-builder.yml` -> `mac.icon` -> `resources/icon.icns`
- Windows app icon: `electron-builder.yml` -> `win.icon` -> `resources/icon.ico`
- Linux app icon: `electron-builder.yml` -> `linux.icon` -> `resources/icon.png`

Avoid workaround fixes such as:

- `app.dock.setIcon(...)` runtime overrides
- installer scripts that run `lsregister`, `killall Dock`, or other cache-refresh behavior
- renaming the icon file only to bypass an old cache
- extra plist/resource overrides when the normal packaging path should work

## What happened

The Dock showed a white border, then a black backing. The tempting explanation was macOS icon cache or a stale bundle. That led to workaround attempts instead of first proving the icon asset was correct.

The real issue was the asset:

- Transparent icon pixels let macOS show a light backing through the corners.
- Replacing that with a smaller opaque source removed the white backing but added black padding because the artwork did not fill the icon canvas.
- The correct fix was to use the full-size icon artwork, crop to visible bounds, resize to fill `1024x1024`, flatten to an opaque dark background, and regenerate `resources/icon.png`, `resources/icon.icns`, and `resources/icon.ico`.

## Verification

A clean result should verify these facts:

- `CFBundleIconFile = icon.icns`
- installed `/Applications/AgentSessionViewer.app/Contents/Resources/icon.icns` matches repo `resources/icon.icns`
- extracted `.icns` sizes have `hasAlpha: no`
- extracted `1024x1024` icon has only tiny margins
- Dock screenshot shows the installed `/Applications/AgentSessionViewer.app` icon filling the Dock slot without white backing or excessive black padding

## Principle

When something looks wrong after packaging, first prove the fresh artifact is intrinsically correct. Only then consider cache or legacy-state cleanup. A fresh install should be right by construction.
