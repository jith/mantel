// The Floating Apps group against the real GTK and libadwaita, in gjs, with
// the settings in memory. What is checked is the rows the user would see and
// what would be written.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

import {buildFloatAppsGroup} from './.float-under-test.js';

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
const group = buildFloatAppsGroup(settings, window);

// Every row of the group, in order.
const rows = () => {
    const found = [];
    const walk = widget => {
        for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
            if (child instanceof Adw.PreferencesRow)
                found.push(child);
            else
                walk(child);
        }
    };
    walk(group);
    return found;
};
const entries = () => rows().filter(r => r instanceof Adw.ActionRow && !(r instanceof Adw.ButtonRow));
const button = (row, icon) => {
    let found = null;
    const walk = widget => {
        for (let c = widget.get_first_child(); c && !found; c = c.get_next_sibling()) {
            if (c instanceof Gtk.Button && c.icon_name === icon)
                found = c;
            else
                walk(c);
        }
    };
    walk(row);
    return found;
};

print('\nthe list  (a row per app, then the ways to add one)');
const defaults = settings.get_strv('float-apps');
expect('a row for each app in the list', entries().length === defaults.length,
    `${entries().length} rows for ${defaults.length}`);
const last = rows().slice(-2);
expect('the add rows come last', last[0] instanceof Adw.ButtonRow && last[1] instanceof Adw.EntryRow,
    last.map(r => r.constructor.name).join(', '));
const calc = entries().find(r => r.subtitle === 'org.gnome.Calculator' || r.title === 'org.gnome.Calculator');
expect('an installed app is named from its desktop file', !!calc,
    calc ? `${calc.title} (${calc.subtitle || 'no desktop file'})` : 'missing');
expect('nothing to reset at the defaults', !button(group, 'edit-undo-symbolic').sensitive, 'reset greyed out');

print('\nadding and removing  (written to the setting)');
const entry = last[1];
entry.text = '  org.example.Tool ';
entry.emit('apply');
expect('an app ID is added, trimmed', settings.get_strv('float-apps').at(-1) === 'org.example.Tool',
    settings.get_strv('float-apps').at(-1));
expect('and shows as a row', entries().some(r => r.title === 'org.example.Tool'), `${entries().length} rows`);
expect('the entry is cleared', entry.text === '', `"${entry.text}"`);
entry.text = 'ORG.EXAMPLE.TOOL';
entry.emit('apply');
expect('the same ID again is not added twice', settings.get_strv('float-apps')
    .filter(id => id.toLowerCase() === 'org.example.tool').length === 1, 'once');
expect('the list can be reset now', button(group, 'edit-undo-symbolic').sensitive, 'reset offered');

const tool = entries().find(r => r.title === 'org.example.Tool');
button(tool, 'user-trash-symbolic').emit('clicked');
expect('its remove button takes it out', !settings.get_strv('float-apps').includes('org.example.Tool'),
    `${settings.get_strv('float-apps').length} left`);
button(group, 'edit-undo-symbolic').emit('clicked');
expect('reset brings the defaults back', settings.get_user_value('float-apps') === null &&
    entries().length === defaults.length, `${entries().length} rows`);

print('\nthe picker  (installed apps not listed already)');
last[0].emit('activated');
const dialog = window.get_visible_dialog();
expect('a dialog opens', dialog instanceof Adw.Dialog, dialog?.title ?? 'none');
const picked = [];
const walkDialog = widget => {
    for (let c = widget.get_first_child(); c; c = c.get_next_sibling()) {
        if (c instanceof Adw.ActionRow)
            picked.push(c);
        walkDialog(c);
    }
};
if (dialog)
    walkDialog(dialog);
expect('listed apps are not offered again', !picked.some(r => defaults.includes(r.subtitle)),
    `${picked.length} offered`);
if (picked.length) {
    const choice = picked[0].subtitle;
    picked[0].emit('activated');
    expect('picking one adds it by desktop ID', settings.get_strv('float-apps').includes(choice), choice);
    expect('and closes the picker', !window.get_visible_dialog(), 'closed');
} else {
    dialog?.close();
}

window.close();
print(`\n${failures === 0 ? 'all assertions passed' : `${failures} FAILURES`}\n`);
System.exit(failures ? 1 : 0);
