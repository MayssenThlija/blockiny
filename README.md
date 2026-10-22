# Blockiny

Blockiny is a Chrome extension for strict focus sessions. Choose the sites, choose the time, and start a session with no undo button.

![Blockiny setup](./assets/setup.jpg)

## Features

- Block custom websites for a fixed session.
- Optional focus goal shown on the blocked page.
- Pomodoro mode with focus rounds and breaks.
- Weekly schedule for automatic sessions.
- Optional YouTube allow-list for specific videos or playlists.
- Optional background sounds: white noise, brown noise, rain, and forest.
- Local stats for focused minutes, sessions, streak, and blocked attempts.
- Full-page view for easier setup and testing.

## Screenshots

### Setup

![Blockiny setup screen](./assets/setup.jpg)

### Active session

![Blockiny active session screen](./assets/active.jpg)

### Blocked page

![Blockiny blocked page](./assets/blocked.jpg)

## Install locally

1. Download or clone this repository.
2. Open `chrome://extensions/` in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `Blockiny` folder.

## Files

- `manifest.json`: extension config.
- `background.js`: session logic, schedules, alarms, notifications, and blocking rules.
- `popup.*`: setup and active-session UI.
- `blocked.*`: page shown when a blocked site is opened.
- `phase.js`: shared timing helpers.
- `yt-guard.js`: YouTube navigation guard for active sessions.
- `offscreen.*` and `noise.js`: optional focus sound playback.

## Privacy

This project stores data locally in the browser. Read `PRIVACY.md` for details.

## License

MIT. See `LICENSE`.
