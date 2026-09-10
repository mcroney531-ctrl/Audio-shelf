import { h, icon, mount, clear, toast } from './dom.js';
import { api } from './api.js';
import { Player, lastBookId } from './player.js';
import { createPlayerUI } from './playerui.js';
import { registerServiceWorker } from './offline.js';
import { canPrompt, promptInstall, isStandalone } from './install.js';
import { homeView, libraryView, bookView, downloadsView, settingsView, importsView } from './views.js';

const THEME_KEY = 'audioshelf.theme';
const app = document.getElementById('app');
const boot = document.getElementById('boot');
const audio = document.getElementById('audio');

const theme = () => localStorage.getItem(THEME_KEY) || 'night';
const setTheme = (value) => {
  document.documentElement.dataset.theme = value;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', value === 'daylight' ? '#f6efe2' : '#12100e');
  try { localStorage.setItem(THEME_KEY, value); } catch { /* ignore */ }
};
setTheme(theme());

const NAV = [
  ['#/', 'home', 'Shelf'],
  ['#/library', 'shelf', 'Library'],
  ['#/listening', 'headphones', 'Listening'],
  ['#/downloads', 'download', 'Downloads'],
  ['#/imports', 'key', 'Add books', { admin: true }],
  ['#/settings', 'settings', 'Settings'],
];

const ROUTES = [
  [/^\/?$/, homeView],
  [/^\/library$/, libraryView],
  [/^\/listening$/, (ctx) => libraryView({ ...ctx, query: new URLSearchParams('filter=in-progress&sort=recent') })],
  [/^\/book\/(?<id>\d+)$/, bookView],
  [/^\/downloads$/, downloadsView],
  [/^\/imports$/, importsView],
  [/^\/settings$/, settingsView],
];

// ---------------------------------------------------------------------------
// Sign in / first-run setup
// ---------------------------------------------------------------------------
function gate({ needsSetup }) {
  return new Promise((resolve) => {
    const error = h('p.formerror');
    const submit = h('button.btn.btn--primary', { type: 'submit' },
      needsSetup ? 'Create shelf' : 'Sign in');

    const form = h('form.form', {
      onsubmit: async (event) => {
        event.preventDefault();
        error.textContent = '';
        submit.disabled = true;
        const data = new FormData(event.target);
        try {
          const result = needsSetup
            ? await api.setup({
              username: data.get('username'),
              password: data.get('password'),
              displayName: data.get('displayName') || data.get('username'),
            })
            : await api.login(data.get('username'), data.get('password'));
          resolve(result.user);
        } catch (err) {
          error.textContent = err.message;
          submit.disabled = false;
        }
      },
    },
      needsSetup ? h('label', 'Your name', h('input', { name: 'displayName', autocomplete: 'name', placeholder: 'Alex' })) : null,
      h('label', 'Username', h('input', { name: 'username', required: true, autocomplete: 'username', autofocus: true })),
      h('label', 'Password', h('input', {
        name: 'password', type: 'password', required: true,
        minlength: needsSetup ? 8 : undefined,
        autocomplete: needsSetup ? 'new-password' : 'current-password',
      })),
      error,
      submit);

    mount(app, h('div.gate', h('div.gate__card',
      h('div.gate__mark', h('i'), h('i'), h('i'), h('i')),
      h('h1', needsSetup ? 'Set up AudioShelf' : 'AudioShelf'),
      h('p', needsSetup
        ? 'This first account is the administrator — it can scan the library and add listeners.'
        : 'Sign in to pick up where you left off.'),
      form)));
    app.hidden = false;
    boot.classList.add('boot--gone');
  });
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------
function buildShell(ctx) {
  const navLink = (href, iconName, label, className) => h(`a.${className}`, { href },
    icon(iconName), h('span', label));

  const installLink = h('button.navlink', {
    hidden: !canPrompt(),
    onclick: async () => {
      const outcome = await promptInstall();
      if (outcome === 'unavailable') location.hash = '#/settings';
      else toast(outcome === 'accepted' ? 'Installing AudioShelf…' : 'Install dismissed');
    },
  }, icon('download'), h('span', 'Install app'));
  document.addEventListener('audioshelf:installable', () => { installLink.hidden = false; });
  document.addEventListener('audioshelf:installed', () => { installLink.hidden = true; });

  const visible = NAV.filter(([, , , options]) => !options?.admin || ctx.user.isAdmin);

  const rail = h('nav.rail',
    h('div.rail__brand', h('img', { src: '/icons/icon-192.png', alt: '' }), 'AudioShelf'),
    ...visible.map(([href, iconName, label]) => navLink(href, iconName, label, 'navlink')),
    h('div.rail__foot',
      installLink,
      h('button.navlink', {
        onclick: () => setTheme(theme() === 'night' ? 'daylight' : 'night'),
      }, icon(theme() === 'night' ? 'sun' : 'moon'), h('span', 'Flip the lights')),
      h('div.rail__user',
        h('span.avatar', ctx.user.displayName.slice(0, 1).toUpperCase()),
        h('div', { style: { minWidth: 0 } },
          h('div', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, ctx.user.displayName),
          h('div.tag', ctx.user.isAdmin ? 'Administrator' : 'Listener')),
        h('button.iconbtn', { title: 'Sign out', onclick: ctx.signOut }, icon('logout', 17)))));

  // The phone bar keeps the four places you actually tap.
  const tabbar = h('nav.tabbar', ...visible
    .filter(([href]) => href !== '#/listening' && href !== '#/imports')
    .map(([href, iconName, label]) => h('a', { href }, icon(iconName), h('span', label))));

  const main = h('main.main');
  mount(app, rail, main, tabbar);
  return { rail, tabbar, main };
}

function markCurrent(shell) {
  const current = location.hash || '#/';
  for (const link of shell.rail.querySelectorAll('.navlink[href]')) {
    const active = link.getAttribute('href') === current
      || (link.getAttribute('href') !== '#/' && current.startsWith(link.getAttribute('href')));
    link.toggleAttribute('aria-current', active);
    if (active) link.setAttribute('aria-current', 'page');
  }
  for (const link of shell.tabbar.querySelectorAll('a')) {
    const active = link.getAttribute('href') === current
      || (link.getAttribute('href') !== '#/' && current.startsWith(link.getAttribute('href')));
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function start() {
  registerServiceWorker();

  let user = null;
  try {
    user = (await api.me()).user;
  } catch (err) {
    if (err.status === 0) {
      // Offline and not signed in yet — the shell cannot do much without a session.
      mount(app, h('div.gate', h('div.gate__card',
        h('h1', 'Offline'),
        h('p', 'AudioShelf cannot reach the server. Reconnect and reload to sign in.'))));
      app.hidden = false;
      boot.classList.add('boot--gone');
      return;
    }
    const { needsSetup } = await api.setupState().catch(() => ({ needsSetup: false }));
    user = await gate({ needsSetup });
  }

  const player = new Player(audio);
  const leaveHooks = [];

  const ctx = {
    user,
    player,
    theme,
    setTheme,
    query: new URLSearchParams(),
    params: {},
    onLeave: (fn) => leaveHooks.push(fn),
    navigate: (hash, { force = false } = {}) => {
      if (location.hash === hash && force) render();
      else location.hash = hash;
    },
    signOut: async () => {
      await api.logout().catch(() => {});
      location.reload();
    },
    playBook: async (bookOrId, options = {}) => {
      try {
        const id = typeof bookOrId === 'object' ? bookOrId.id : bookOrId;
        const detail = typeof bookOrId === 'object' && bookOrId.tracks ? bookOrId : await api.book(id);
        await player.open(detail, options);
        ui.open();
      } catch (err) {
        toast(err.message || 'Could not start that book', 'bad');
      }
    },
  };

  const shell = buildShell(ctx);
  const ui = createPlayerUI(player, ctx);
  app.append(ui.dock, ui.sheet);
  app.hidden = false;
  boot.classList.add('boot--gone');
  setTimeout(() => boot.remove(), 600);

  async function render() {
    while (leaveHooks.length) leaveHooks.pop()();
    const raw = (location.hash || '#/').slice(1);
    const [path, search] = raw.split('?');
    ctx.query = new URLSearchParams(search || '');
    markCurrent(shell);

    for (const [pattern, view] of ROUTES) {
      const match = pattern.exec(path);
      if (!match) continue;
      ctx.params = match.groups || {};
      try {
        const node = await view(ctx);
        mount(shell.main, node);
      } catch (err) {
        mount(shell.main, h('div.empty',
          h('h2', err.status === 404 ? 'Not found' : 'Something went sideways'),
          h('p', err.message),
          h('a.btn', { href: '#/' }, 'Back to the shelf')));
      }
      shell.main.scrollTop = 0;
      window.scrollTo({ top: 0 });
      return;
    }
    mount(shell.main, h('div.empty', h('h2', 'No such page'), h('a.btn', { href: '#/' }, 'Back to the shelf')));
  }

  window.addEventListener('hashchange', render);
  await render();

  // Re-open whatever was playing last, paused and ready.
  const lastId = lastBookId();
  if (lastId) {
    api.book(lastId)
      .then((book) => book.progress?.position ? player.open(book, { autoplay: false }) : null)
      .catch(() => {});
  }

  document.addEventListener('audioshelf:update-ready', () =>
    toast('An update is ready — reload to apply'));

  window.addEventListener('offline', () => toast('Offline — downloaded books still play'));
  window.addEventListener('online', () => player.flushPending());
}

start().catch((err) => {
  console.error(err);
  mount(app, h('div.gate', h('div.gate__card', h('h1', 'Failed to start'), h('p', err.message))));
  app.hidden = false;
  boot.classList.add('boot--gone');
});
