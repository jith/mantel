# Mantel

Numbered workspaces, a dock-style auto-hiding top bar, and Hyprland-style
auto-tiling for GNOME Shell.

Each feature can be turned off on its own, so you can take one and leave the
others.

## Workspace numbers

GNOME shows workspaces in the top bar as anonymous dots — you can see how many
there are, but not which is which. Mantel replaces them with numbers.

- **Click a number** to switch to that workspace.
- **`Super`+`1`…`0`** jumps straight to a workspace, and **creates it if it does
  not exist yet**, so you are not limited to however many happen to be open.
- The bottom-centre workspace switcher popup is gone — the top bar already says
  which workspace is active, so the popup is redundant.

The numbers inherit the panel's own foreground colour, so they read correctly on
a light or a dark top bar without any theming.

## Auto-hide the top bar

The bar stays out of the way while a window needs the space, and comes back when
you push the pointer against the top edge of the screen.

This is *intellihide*, not plain auto-hide: the bar is **visible whenever nothing
overlaps it** — an empty workspace, or windows that sit clear of the top — and
only leaves when a window is actually in the way. It follows the same rules,
timings and pressure threshold as the Ubuntu Dock, so both screen edges behave
identically if you use both.

It stays visible in the overview and while a panel menu is open, and it will not
intrude over a fullscreen window.

### One behaviour worth knowing about

While auto-hide is enabled, the top bar **stops reserving screen space**. Windows
keep the full height of the screen and the bar floats over them when revealed.

That is deliberate: it means nothing resizes when you peek at the clock. The
trade-off is that windows are now free to sit flush against the top of the
screen, and new windows may be placed there.

## Auto-tiling

Windows are laid out as they open, following Hyprland's *dwindle* layout:
the first window on a workspace takes all of it, and each new window splits
the window that had focus, along its longer side. Closing a window hands its
space back to the window it was split from.

- **Floating apps.** Small utility apps (Calculator, Characters, Clocks,
  image and video viewers, …) open floating in front of the layout. The list
  is in **Settings → Floating Apps**; `Super`+`T` moves any window in or out.
  Any app window the layout cannot take, such as one that cannot be resized
  or a dialog, floats too. Floating windows always stay above tiled ones.
- **Minimum sizes are respected.** A window is never given less room than it
  will take. One that cannot fit beside the others either way round opens
  floating instead of being drawn over them.
- **Maximize floats.** GNOME's title bar buttons and shortcuts for minimize
  and maximize are removed while tiling (and given back afterwards), and a
  double click on a title bar does nothing. Apps that draw their own title
  bar — Flutter apps such as Ubuntu's App Center and Security
  Center, Electron apps such as VS Code — keep their buttons. Maximizing a
  tiled window, or `Super`+`Alt`+`F`, floats it over its tile, above the
  others; unmaximizing it, or `Super`+`T`, puts it back in the same tile.
  Minimizing takes a window out of the layout until it is restored.
  Focusing a tiled window under a maximized one maximizes it in that one's
  place.
- **Dragging** a tiled window onto another swaps the two; dragging a shared
  edge moves it for both neighbours.
- **Focus follows the mouse**, without raising the window (GNOME's *sloppy*
  focus, handed back afterwards). Keys that move focus or windows take the
  pointer along, so focus stays where the keys put it. It can be switched off.
- Focus, swap, resize, split, pseudo-tile, pop-out and scratchpad keys are
  listed, and can be changed, in **Settings → Shortcuts**. Focus and swap
  carry on to the next monitor past the edge of the layout; resize grows or
  shrinks a floating window. GNOME's (and Ubuntu Tiling Assistant's)
  shortcuts that would maximize or tile a window are switched off meanwhile,
  as are edge tiling and its drag previews; GNOME's quick settings, zoom and
  move-to-monitor shortcuts give up only the chords Mantel uses by default.
  All are handed back when auto-tiling is turned off.
- Picture-in-picture opens small in the top right corner, on every workspace.
- The layout survives the lock screen.

It is off by default.

To see why a window was tiled or floated, turn on logging and watch the
journal:

```sh
gsettings --schemadir ~/.local/share/gnome-shell/extensions/mantel@jith.github.io/schemas \
  set org.gnome.shell.extensions.mantel debug true
journalctl -f -o cat /usr/bin/gnome-shell | grep Mantel
```

## Settings

In **Extensions → Mantel → Settings**:

| Setting | Default |
| --- | --- |
| Workspace numbers | on |
| Auto-hide the top bar | on |
| Tile windows as they open | off |
| Focus follows the mouse, while tiling | on |

Each takes effect immediately — no logout needed to toggle it.

## Requirements

GNOME Shell 50.

GNOME 48 and 49 are not supported yet. Their `ActivitiesButton` handles clicks
through `vfunc_event()` rather than a `Clutter.ClickGesture`, which the numbered
indicator relies on both to receive clicks and to stop the overview opening on
top of them. Supporting them needs a separate code path, not just a wider
version range.

## Installing

From [extensions.gnome.org](https://extensions.gnome.org) once published.

To install from source:

```sh
git clone https://github.com/jith/mantel.git
cd mantel
gnome-extensions pack --force \
  --extra-source=autohide.js \
  --extra-source=workspaces.js \
  --extra-source=tiling.js \
  --extra-source=rules.js \
  --extra-source=outline.js \
  --extra-source=borrowed.js \
  --extra-source=shortcuts.js \
  --extra-source=prefs \
  --schema=schemas/org.gnome.shell.extensions.mantel.gschema.xml
gnome-extensions install --force mantel@jith.github.io.shell-extension.zip
```

Then log out and back in. GNOME Shell imports each extension exactly once per
session, so **any** change to the code needs a new session before it takes
effect — on Wayland there is no way to restart the shell in place.

```sh
gnome-extensions enable mantel@jith.github.io
```

## Credits

The auto-hide behaviour is derived from
[dash-to-dock](https://github.com/micheleg/dash-to-dock) (`docking.js` and
`intellihide.js`), GPL-2.0-or-later. No code was copied verbatim, but the
algorithm, the state machine, the window-overlap test, the pressure-barrier
lifecycle and the timing constants all follow its implementation closely and
deliberately — it had already solved the cases this kind of thing trips over.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
