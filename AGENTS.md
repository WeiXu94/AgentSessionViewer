@CLAUDE.md

## Lessons

- Use `agent-browser` to test and debug this Electron app, not only the plain Vite renderer URL. Start with `agent-browser skills get electron --full`.
- To test the real Electron preload/main integration, launch a CDP-enabled Electron instance:
  `ELECTRON_RENDERER_URL=http://localhost:5173 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . --remote-debugging-port=9222`
- Then drive it with per-command CDP flags, for example:
  `agent-browser --session asv-electron --cdp 9222 snapshot -i`
- If `agent-browser connect 9222` fails with `Target.createTarget: Not supported`, keep using `--cdp 9222` on each command.
- Confirm the target is the real Electron app before trusting UI results: `agent-browser --session asv-electron --cdp 9222 eval "JSON.stringify({ hasApi: !!window.api, keys: window.api ? Object.keys(window.api) : [] })"` should show `window.api`.
- Stop any temporary CDP Electron process after testing; leave the user's existing dev app alone unless asked.
