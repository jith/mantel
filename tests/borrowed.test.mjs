import {BorrowedSetting} from './.borrowed-under-test.mjs';
import {Settings} from './stubs.mjs';

let failures = 0;
const expect = (label, ok, detail) => {
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(44)} ${detail}`);
};

// Shaped like Tiling Assistant's focus hint: 1 and 3 are switched off, and
// anything else is left alone. A fresh pair of settings each time, and a loan
// made per session the way AutoTile makes one per enable() and disable().
const session = (target, mantel) => new BorrowedSetting({
    mantel, record: 'lent', target, key: 'hint', type: 'int',
    change: hint => [1, 3].includes(hint) ? 0 : null,
});
const settings = () => [new Settings({hint: 1}), new Settings({lent: 0})];
const state = (target, mantel) =>
    `hint=${target.get_int('hint')}${'hint' in target.user ? '' : ' (default)'}, ` +
    `lent=${mantel.get_user_value('lent')?.deepUnpack() ?? 'nothing'}`;

console.log('\nborrowed settings  (handed back as they were found)');
let [target, mantel] = settings();
session(target, mantel).take();
expect('taken, and the old value on record', target.get_int('hint') === 0 &&
    mantel.get_user_value('lent')?.deepUnpack() === 1, state(target, mantel));
session(target, mantel).giveBack();
expect('a default goes back to being the default', !('hint' in target.user) &&
    mantel.get_user_value('lent') === null, state(target, mantel));

[target, mantel] = settings();
target.set_int('hint', 3);
session(target, mantel).take();
session(target, mantel).giveBack();
expect('the user\'s own value goes back as theirs', target.user.hint === 3 &&
    mantel.get_user_value('lent') === null, state(target, mantel));

console.log('\na logout while it is out  (no disable, then a fresh session)');
[target, mantel] = settings();
target.set_int('hint', 3);
session(target, mantel).take();
session(target, mantel).take();
expect('the next session does not take its own value', target.get_int('hint') === 0 &&
    mantel.get_user_value('lent')?.deepUnpack() === 3, state(target, mantel));
session(target, mantel).giveBack();
expect('and hands back the user\'s', target.user.hint === 3, state(target, mantel));

console.log('\nchanged by the user  (theirs to keep)');
[target, mantel] = settings();
session(target, mantel).take();
target.set_int('hint', 2);
session(target, mantel).giveBack();
expect('while it was out: left alone, loan closed', target.get_int('hint') === 2 &&
    mantel.get_user_value('lent') === null, state(target, mantel));

[target, mantel] = settings();
session(target, mantel).take();
target.set_int('hint', 2);         // between sessions, with Mantel not running
session(target, mantel).take();
expect('between sessions, to one left alone: dropped', target.get_int('hint') === 2 &&
    mantel.get_user_value('lent') === null, state(target, mantel));

[target, mantel] = settings();
session(target, mantel).take();
target.set_int('hint', 3);
session(target, mantel).take();
expect('between sessions, to another: borrowed anew', target.get_int('hint') === 0 &&
    mantel.get_user_value('lent')?.deepUnpack() === 3, state(target, mantel));

console.log('\nnothing to change  (nothing written)');
[target, mantel] = settings();
target.set_int('hint', 2);
session(target, mantel).take();
expect('nothing borrowed', target.user.hint === 2 && mantel.get_user_value('lent') === null,
    state(target, mantel));
session(target, mantel).giveBack();
expect('and nothing handed back', target.user.hint === 2, state(target, mantel));

console.log('\na keybinding  (a list, compared by what is in it)');
const keys = new Settings({minimize: ['<Super>h']});
const record = new Settings({lent: []});
const unbound = () => new BorrowedSetting({
    mantel: record, record: 'lent', target: keys, key: 'minimize', type: 'strv',
    change: accels => accels.length ? [] : null,
});
keys.set_strv('minimize', ['<Super>h', '<Super>m']);
unbound().take();
unbound().take();
expect('unbound, once, whatever the next read returns',
    keys.get_strv('minimize').length === 0 &&
    record.get_user_value('lent')?.deepUnpack().join() === '<Super>h,<Super>m',
    `minimize=[${keys.get_strv('minimize')}]`);
unbound().giveBack();
expect('and bound again as it was', keys.get_strv('minimize').join() === '<Super>h,<Super>m' &&
    record.get_user_value('lent') === null, `minimize=[${keys.get_strv('minimize')}]`);
keys.reset('minimize');
unbound().take();
unbound().giveBack();
expect('a default binding goes back to being the default', !('minimize' in keys.user),
    `minimize=[${keys.get_strv('minimize')}]`);

console.log(`\n${failures === 0 ? 'all assertions passed' : `${failures} FAILURES`}\n`);
process.exit(failures ? 1 : 0);
