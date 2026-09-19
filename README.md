# Mantel

Numbered workspaces and a dock-style auto-hiding top bar for GNOME Shell.

Two things the GNOME top bar could do better. Either can be turned off on its
own, so you can take one and leave the other.

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

## Settings

Two switches, in **Extensions → Mantel → Settings**:

| Setting | Default |
| --- | --- |
| Workspace numbers | on |
| Auto-hide the top bar | on |

Both take effect immediately — no logout needed to toggle them.

## Requirements

GNOME Shell 48, 49 or 50.

## Installing

From [extensions.gnome.org](https://extensions.gnome.org) once published.

To install from source:

```sh
git clone https://github.com/jith/mantel.git
cd mantel
gnome-extensions pack --force \
  --extra-source=autohide.js \
  --extra-source=workspaces.js \
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
