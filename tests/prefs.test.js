// The Shortcuts page against the real GTK and libadwaita, in gjs. Nothing is
// shown: the window is never presented, the settings live in memory rather
// than in dconf, and key presses are fed straight to the capture dialog's
// controller. What is checked is what the user would see and what would be
// written.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

import {buildShortcutsPage} from './.prefs-under-test.js';
import {SHORTCUT_GROUPS} from '../shortcuts.js';

Adw.init();

let failures = 0;
const expect = (label, ok, detail) => {
    if (!ok)
        failures++;
    print(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(44)} ${detail}`);
};

const here = Gio.File.new_for_path(System.programPath).get_parent().get_parent();
const source = Gio.SettingsSchemaSource.new_from_directory(
    here.get_child('schemas').get_path(), Gio.SettingsSchemaSource.get_default(), false);
const settings = new Gio.Settings({
    settings_schema: source.lookup('org.gnome.shell.extensions.mantel', false),
    backend: Gio.memory_settings_backend_new(),
});

const window = new Adw.PreferencesWindow();
const page = buildShortcutsPage(settings, window);

// Every row, by title, and what it shows.
const rows = [];
const walk = widget => {
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        if (child instanceof Adw.ActionRow && !(child instanceof Adw.ButtonRow))
            rows.push(child);
        walk(child);
    }
};
walk(page);
const row = title => rows.find(r => r.title === title);
const labelOf = r => {
    let found = null;
    const find = widget => {
        for (let c = widget.get_first_child(); c && !found; c = c.get_next_sibling()) {
            if (c instanceof Adw.ShortcutLabel)
                found = c;
            else
                find(c);
        }
    };
    find(r);
    return found?.accelerator;
};

print('\nthe page  (every chord, as the schema has it)');
const chords = SHORTCUT_GROUPS.flatMap(([, keys]) => keys).length;
expect('a row for each chord', rows.length === chords, `${rows.length} of ${chords}`);
const pseudo = row('Pseudo-tile the focused window');
expect('rows show the default chord', labelOf(pseudo) === '<Super><Alt>p', labelOf(pseudo));
const clean = rows.filter(r => r.subtitle).map(r => `${r.title}: ${r.subtitle}`);
expect('no default collides on this desktop', clean.length === 0, clean.join('; ') || 'none');

print('\nsomething else has it  (marked, never changed)');
const monitorKeys = new Gio.Settings({schema_id: 'org.gnome.mutter.keybindings'});
const monitorBefore = monitorKeys.get_strv('switch-monitor').join(',');
settings.set_strv('toggle-pseudo', ['<Super>p']);
expect('a chord GNOME uses is marked', /Also used by/.test(pseudo.subtitle), pseudo.subtitle);
settings.reset('toggle-pseudo');
expect('and unmarked once it is not', !pseudo.subtitle, pseudo.subtitle || 'clear');

// Press a chord into the dialog the row opens.
const press = (title, keyval, mods) => {
    row(title).emit('activated');
    const dialog = window.get_visible_dialog();
    const controllers = dialog.observe_controllers();
    const keys = Array.from({length: controllers.get_n_items()}, (_, i) => controllers.get_item(i))
        .find(c => c instanceof Gtk.EventControllerKey);
    const display = Gdk.Display.get_default();
    const [, entries] = display.map_keyval(keyval);
    keys.emit('key-pressed', keyval, entries[0].keycode, mods);
    return dialog;
};

print('\nsetting a chord  (by pressing it)');
press('Pseudo-tile the focused window', Gdk.KEY_y,
    Gdk.ModifierType.SUPER_MASK | Gdk.ModifierType.ALT_MASK);
expect('the pressed chord is written', settings.get_strv('toggle-pseudo')[0] === '<Alt><Super>y',
    settings.get_strv('toggle-pseudo').join(','));
expect('the row offers a reset', row('Pseudo-tile the focused window').subtitle === '' &&
    settings.get_user_value('toggle-pseudo') !== null, 'changed from the default');

// Shift turns minus into underscore, and that chord is Mantel's own "move
// the edge up a lot" — so it is asked about first, and stored as minus.
press('Pseudo-tile the focused window', Gdk.KEY_underscore,
    Gdk.ModifierType.SUPER_MASK | Gdk.ModifierType.SHIFT_MASK | Gdk.ModifierType.CONTROL_MASK);
let confirm = window.get_visible_dialog();
expect('Mantel’s own chord is asked about first', confirm instanceof Adw.AlertDialog &&
    /already used/.test(confirm.body), confirm?.body ?? 'no dialog');
confirm.emit('response', 'set');
confirm.close();
expect('handed over, and stored as the key is labelled',
    settings.get_strv('toggle-pseudo')[0] === '<Shift><Control><Super>minus' &&
    settings.get_strv('resize-up-lot').length === 0,
    `pseudo=${settings.get_strv('toggle-pseudo')} up-lot=${settings.get_strv('resize-up-lot')}`);

const letter = press('Float the focused window', Gdk.KEY_q, 0);
expect('a bare letter is refused', /cannot be a shortcut/.test(letter.body) &&
    settings.get_strv('toggle-float')[0] === '<Super>t', letter.body.split('.')[0]);
letter.close();

press('Float the focused window', Gdk.KEY_BackSpace, 0);
expect('Backspace disables it', settings.get_strv('toggle-float').length === 0,
    `[${settings.get_strv('toggle-float')}]`);

const cancelled = press('Swap with the window left', Gdk.KEY_Escape, 0);
expect('Escape changes nothing, and closes', settings.get_strv('swap-left')[0] ===
    '<Super><Shift>Left' && window.get_visible_dialog() !== cancelled,
    settings.get_strv('swap-left').join(','));

print('\nsomeone else\'s chord  (confirmed, and theirs left alone)');
press('Show or hide the scratchpad', Gdk.KEY_p, Gdk.ModifierType.SUPER_MASK);
confirm = window.get_visible_dialog();
expect('GNOME’s chord is asked about first', /not predictable/.test(confirm?.body ?? ''),
    confirm?.body ?? 'no dialog');
confirm.emit('response', 'cancel');
confirm.close();
expect('cancelling keeps the old one', settings.get_strv('scratchpad')[0] === '<Super>s',
    settings.get_strv('scratchpad').join(','));
expect('GNOME’s own shortcut is untouched',
    monitorKeys.get_strv('switch-monitor').join(',') === monitorBefore, monitorBefore);

// GNOME's own maximize chord is switched off while windows are tiled, the
// only time Mantel's chords are bound, so the two never meet.
const maximize = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.keybindings'});
const [maximizeChord] = maximize.get_default_value('toggle-maximized').deepUnpack();
const [, maxKey, maxMods] = Gtk.accelerator_parse(maximizeChord);
press('Show or hide the scratchpad', maxKey, maxMods);
expect('a chord auto-tiling switches off is free',
    !window.get_visible_dialog() && settings.get_strv('scratchpad')[0] === maximizeChord,
    settings.get_strv('scratchpad').join(','));
settings.reset('scratchpad');

print('\nreset  (back to the defaults)');
for (const key of settings.settings_schema.list_keys())
    settings.reset(key);
expect('every chord back to its default', settings.get_strv('resize-up-lot')[0] ===
    '<Super><Shift><Control>minus' && settings.get_strv('toggle-float')[0] === '<Super>t',
    'defaults');

window.close();
print(`\n${failures === 0 ? 'all assertions passed' : `${failures} FAILURES`}\n`);
System.exit(failures ? 1 : 0);
