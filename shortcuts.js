// SPDX-License-Identifier: GPL-3.0-or-later
//
// Every chord Mantel binds, in the groups and order the Shortcuts page shows
// them. Each name is a schema key holding its default, title and description.

const RESIZE = [];
for (const size of ['', '-little', '-lot']) {
    for (const edge of ['left', 'right', 'up', 'down'])
        RESIZE.push(`resize-${edge}${size}`);
}

export const SHORTCUT_GROUPS = [
    ['Windows', ['toggle-float', 'toggle-maximize', 'toggle-split', 'toggle-pseudo', 'toggle-pop']],
    ['Scratchpad', ['scratchpad', 'to-scratchpad']],
    ['Focus', ['focus-left', 'focus-right', 'focus-up', 'focus-down']],
    ['Swap', ['swap-left', 'swap-right', 'swap-up', 'swap-down']],
    ['Resize', RESIZE],
];

// Other shortcuts that auto-tiling unbinds while it runs: those that maximize,
// minimize or tile a window, which would take it out of the layout, and
// GNOME's defaults that are also Mantel's (SHARED_DEFAULTS).
export const BORROWED_SHORTCUTS = {
    'org.gnome.desktop.wm.keybindings': ['minimize', 'maximize', 'unmaximize',
        'toggle-maximized', 'maximize-horizontally', 'maximize-vertically',
        'move-to-monitor-left', 'move-to-monitor-right', 'move-to-monitor-up', 'move-to-monitor-down'],
    'org.gnome.mutter.keybindings': ['toggle-tiled-left', 'toggle-tiled-right'],
    'org.gnome.shell.keybindings': ['toggle-quick-settings'],
    'org.gnome.settings-daemon.plugins.media-keys': ['magnifier-zoom-in', 'magnifier-zoom-out'],
    'org.gnome.shell.extensions.tiling-assistant': ['tile-maximize',
        'tile-maximize-horizontally', 'tile-maximize-vertically',
        'tile-left-half', 'tile-right-half', 'restore-window'],
};

// Of those, the ones that give up only this chord, and keep one the user set.
const SHARED_DEFAULTS = {
    'move-to-monitor-left': '<Super><Shift>Left',
    'move-to-monitor-right': '<Super><Shift>Right',
    'move-to-monitor-up': '<Super><Shift>Up',
    'move-to-monitor-down': '<Super><Shift>Down',
    'toggle-quick-settings': '<Super>s',
    'magnifier-zoom-in': '<Alt><Super>equal',
    'magnifier-zoom-out': '<Alt><Super>minus',
};

// What a borrowed key holds while auto-tiling runs, or null if it keeps all
// it has. The same answer in every session, so a loan can be handed back.
export function unbind(key) {
    const chord = SHARED_DEFAULTS[key];
    if (!chord)
        return accels => accels.length ? [] : null;
    return accels => accels.includes(chord) ? accels.filter(accel => accel !== chord) : null;
}
