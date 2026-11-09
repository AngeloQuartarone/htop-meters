# Changelog

## Unreleased

First public release.

- htop's meters in the side bar, in ASCII: one bar per CPU core (nice,
  user, kernel), in two columns when the side bar is wide enough; Mem; Swp;
  Tasks (processes, threads, running) and Uptime.
- Memory as the system shows it: on macOS like Activity Monitor (app,
  wired, compressed, cached files), on Linux like htop (used, buffers,
  shared, cache).
- Colors from the active theme's terminal palette.
- The section sits at the bottom of the Explorer, Source Control, Run and
  Debug, Testing and the Claude Code sessions list; only the visible copy
  updates, and only while it is open.
- Settings: `htopMeters.refreshInterval`, `htopMeters.showTasks`,
  `htopMeters.showInClaude`.
