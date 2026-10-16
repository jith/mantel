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
