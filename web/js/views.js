import { h, icon, mount, clear, humanDuration, clockTime, relativeTime, toast } from './dom.js';
import { api, coverUrl } from './api.js';
import { downloadBook, removeDownload, isDownloaded, downloadIndex, storageUsage, formatBytes, clearAllDownloads, requestPersistence } from './offline.js';

/** Deterministic colour so every book without art still looks like a specific book. */
function seedColor(text) {
  let hash = 0;
  for (const char of String(text || 'audioshelf')) hash = (hash * 31 + char.charCodeAt(0)) % 360000;
  const hue = hash % 360;
  return `hsl(${hue} 42% 42%)`;
}

export function coverNode(book, { eager = false } = {}) {
  const url = coverUrl(book);
  if (url) {
    return h('img', {
      src: url,
      alt: `Cover of ${book.title}`,
      loading: eager ? 'eager' : 'lazy',
      decoding: 'async',
      onerror: (event) => event.target.replaceWith(drawnCover(book)),
    });
  }
  return drawnCover(book);
}

function drawnCover(book) {
  return h('div.cover--drawn', { style: { '--seed': seedColor(book.title + (book.author || '')) } },
    h('div.cover__rule'),
    h('div.cover__title', book.title),
    h('div.cover__by', book.author || 'Unknown author'));
}

const remainingLabel = (book) => {
  const left = Math.max(0, (book.duration || 0) - (book.progress?.position || 0));
  return `${humanDuration(left)} left`;
};

export function bookCard(book, index = 0, { onPlay } = {}) {
  const percent = book.duration ? Math.min(100, ((book.progress?.position || 0) / book.duration) * 100) : 0;
  const finished = book.progress?.finished;

  const cover = h('div.cover', { style: { '--i': index } },
    coverNode(book),
    finished ? h('span.cover__badge.cover__badge--done', icon('check', 12), 'Finished')
      : percent > 0.5 ? h('span.cover__badge', `${Math.round(percent)}%`) : null,
    onPlay ? h('button.cover__play', {
      type: 'button',
      title: `Play ${book.title}`,
      'aria-label': `Play ${book.title}`,
      onclick: (event) => { event.preventDefault(); event.stopPropagation(); onPlay(book); },
    }, icon('play', 18)) : null,
    percent > 0 && !finished ? h('div.cover__bar', h('i', { style: { width: `${percent}%` } })) : null);

  return h('a.card', { href: `#/book/${book.id}`, style: { '--i': index } },
    cover,
    h('div',
      h('div.card__title', book.title),
      h('div.card__meta', book.author || 'Unknown author'),
      h('div.card__meta', percent > 0 && !finished ? remainingLabel(book) : humanDuration(book.duration))));
}

const sectionHead = (title, link) =>
  h('div.section__head', h('h2', title), link ? h('a', { href: link.href }, link.label, ' →') : null);

const emptyState = (title, ...body) => h('div.empty', h('h2', title), ...body);

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------
export async function homeView(ctx) {
  const data = await api.shelves();
  const hour = new Date().getHours();
  const greeting = hour < 5 ? 'Still up' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const node = h('div');

  node.append(h('header.topbar',
    h('div', h('p.eyebrow', 'Your shelf'), h('h1', `${greeting}, ${ctx.user.displayName.split(' ')[0]}`))));

  if (!data.totals.books) {
    node.append(emptyState('The shelf is empty',
      h('p', 'Drop audiobooks into your library folder — one folder per book — then run a scan.'),
      h('p', h('code', ctx.user.isAdmin ? 'Settings → Library → Scan now' : 'Ask your admin to run a scan')),
      ctx.user.isAdmin ? h('button.btn.btn--primary', {
        onclick: async () => { await api.scan(); toast('Scanning the library…'); },
      }, icon('refresh'), 'Scan now') : null));
    return node;
  }

  if (data.continueListening.length) {
    node.append(h('section.section',
      sectionHead('Continue listening', { href: '#/library?filter=in-progress', label: 'All in progress' }),
      h('div.rowscroll', data.continueListening.map((book, i) =>
        bookCard(book, i, { onPlay: ctx.playBook })))));
  }

  node.append(h('section.section',
    sectionHead('Recently added', { href: '#/library?sort=added', label: 'Library' }),
    h('div.rowscroll', data.recentlyAdded.map((book, i) => bookCard(book, i, { onPlay: ctx.playBook })))));

  if (data.series.length) {
    node.append(h('section.section',
      sectionHead('Series'),
      h('div.chips', data.series.map((entry) =>
        h('a.chip', { href: `#/library?series=${encodeURIComponent(entry.name)}` }, entry.name, ' · ', entry.books)))));
  }

  if (data.authors.length) {
    node.append(h('section.section',
      sectionHead('Authors'),
      h('div.chips', data.authors.map((entry) =>
        h('a.chip', { href: `#/library?author=${encodeURIComponent(entry.name)}` }, entry.name, ' · ', entry.books)))));
  }

  node.append(h('p.tag', `${data.totals.books} books · ${humanDuration(data.totals.duration)} on the shelf · ${data.totals.finished} finished`));
  return node;
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------
const FILTERS = [
  ['', 'Everything'],
  ['in-progress', 'In progress'],
  ['unstarted', 'Not started'],
  ['finished', 'Finished'],
];
const SORTS = [
  ['title', 'Title'],
  ['author', 'Author'],
  ['added', 'Recently added'],
  ['recent', 'Recently played'],
  ['duration', 'Longest'],
];

export async function libraryView(ctx) {
  const params = ctx.query;
  const node = h('div');
  const grid = h('div.grid');
  const count = h('p.tag');

  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    location.hash = `#/library${next.toString() ? '?' + next : ''}`;
  };

  const search = h('input', {
    type: 'search',
    placeholder: 'Search titles, authors, narrators…',
    value: params.get('q') || '',
    oninput: (event) => {
      clearTimeout(node._timer);
      const value = event.target.value;
      node._timer = setTimeout(() => load({ q: value }), 260);
    },
  });

  const heading = params.get('author') || params.get('series') || 'Library';
  node.append(h('header.topbar',
    h('div',
      h('p.eyebrow', params.get('series') ? 'Series' : params.get('author') ? 'Author' : 'Browse'),
      h('h1', heading)),
    h('div.field', icon('search'), search)));

  node.append(h('div.chips', { style: { marginBottom: '18px' } },
    ...FILTERS.map(([value, label]) => h('button.chip', {
      type: 'button',
      'aria-pressed': String((params.get('filter') || '') === value),
      onclick: () => setParam('filter', value),
    }, label)),
    h('select.chip', {
      style: { paddingRight: '10px' },
      onchange: (event) => setParam('sort', event.target.value),
    }, ...SORTS.map(([value, label]) =>
      h('option', { value, selected: (params.get('sort') || 'title') === value }, label)))));

  node.append(count, grid);

  async function load(overrides = {}) {
    const request = {
      q: overrides.q ?? params.get('q') ?? '',
      filter: params.get('filter') || '',
      sort: params.get('sort') || 'title',
      author: params.get('author') || '',
      series: params.get('series') || '',
      limit: 500,
    };
    const data = await api.books(request);
    count.textContent = data.total
      ? `${data.total} book${data.total === 1 ? '' : 's'}`
      : '';
    mount(grid, data.books.length
      ? data.books.map((book, i) => bookCard(book, i, { onPlay: ctx.playBook }))
      : emptyState('Nothing matches', h('p', 'Try a different filter or search term.')));
  }

  await load();
  return node;
}

// ---------------------------------------------------------------------------
// Book detail
// ---------------------------------------------------------------------------
export async function bookView(ctx) {
  const book = await api.book(ctx.params.id);
  const percent = book.duration ? ((book.progress?.position || 0) / book.duration) * 100 : 0;
  const downloadState = h('span');

  const playLabel = book.progress?.position > 5
    ? `Resume · ${clockTime(book.progress.position)}`
    : 'Start listening';

  const downloadBtn = h('button.btn', {
    onclick: async () => {
      if (isDownloaded(book.id)) {
        await removeDownload(book.id);
        toast('Download removed');
      } else {
        downloadBtn.disabled = true;
        try {
          await requestPersistence();
          await downloadBook(book, ({ done, total }) => {
            downloadState.textContent = ` ${done}/${total}`;
          });
          toast('Saved for offline listening');
        } catch (err) {
          toast(err.message || 'Download failed', 'bad');
        } finally {
          downloadBtn.disabled = false;
          downloadState.textContent = '';
        }
      }
      renderDownloadButton();
    },
  });

  function renderDownloadButton() {
    const saved = isDownloaded(book.id);
    mount(downloadBtn, icon(saved ? 'check' : 'download'), saved ? 'Downloaded' : 'Download', downloadState);
    downloadBtn.classList.toggle('btn--ghost', saved);
  }
  renderDownloadButton();

  const chapterList = h('div.list', ...(book.chapters.length ? book.chapters : book.tracks).map((entry, index) =>
    h('button.list__row', {
      type: 'button',
      onclick: () => ctx.playBook(book, { position: entry.start }),
    },
      h('span.list__num', String(index + 1).padStart(2, '0')),
      h('span.list__name', entry.title),
      h('span.list__time', clockTime(entry.start)))));

  const bookmarkList = h('div.list');
  const renderBookmarks = (bookmarks) => mount(bookmarkList, bookmarks.length
    ? bookmarks.map((mark) => h('div.list__row',
      h('span.list__num', icon('bookmark', 15)),
      h('button.list__name', {
        type: 'button',
        style: { textAlign: 'left' },
        onclick: () => ctx.playBook(book, { position: mark.position }),
      }, mark.note || 'Bookmark'),
      h('span.list__time', clockTime(mark.position)),
      h('button.iconbtn', {
        type: 'button',
        title: 'Delete bookmark',
        onclick: async () => {
          await api.deleteBookmark(mark.id);
          renderBookmarks((await api.book(book.id)).bookmarks);
        },
      }, icon('trash', 16))))
    : h('p.tag', { style: { padding: '10px 12px' } }, 'No bookmarks yet — drop one from the player.'));
  renderBookmarks(book.bookmarks);

  return h('div.detail',
    h('div.detail__art',
      h('div.cover', coverNode(book, { eager: true })),
      percent > 0 ? h('div',
        h('div.progressline', h('i', { style: { width: `${Math.min(100, percent)}%` } })),
        h('p.tag', { style: { marginTop: '8px' } },
          book.progress?.finished ? 'Finished' : `${Math.round(percent)}% · ${humanDuration(book.duration - book.progress.position)} left`)) : null),

    h('div',
      book.series ? h('p.eyebrow', `${book.series}${book.seriesIndex ? ` · Book ${book.seriesIndex}` : ''}`) : null,
      h('h1.detail__title', book.title),
      h('p.detail__by',
        'by ', h('a', { href: `#/library?author=${encodeURIComponent(book.author || '')}` }, h('b', book.author || 'Unknown author')),
        book.narrator ? [' · narrated by ', h('b', book.narrator)] : null),

      h('div.detail__actions',
        h('button.btn.btn--primary', { onclick: () => ctx.playBook(book) }, icon('play'), playLabel),
        downloadBtn,
        h('button.btn.btn--ghost', {
          onclick: async () => {
            const finished = !book.progress?.finished;
            await api.saveProgress(book.id, {
              position: finished ? book.duration : 0,
              finished,
            });
            toast(finished ? 'Marked as finished' : 'Marked as unplayed');
            ctx.navigate(location.hash, { force: true });
          },
        }, icon('check'), book.progress?.finished ? 'Mark unplayed' : 'Mark finished')),

      h('div.detail__stats',
        h('div', h('b', humanDuration(book.duration)), 'runtime'),
        h('div', h('b', String((book.chapters.length || book.tracks.length))), book.chapters.length ? 'chapters' : 'files'),
        book.year ? h('div', h('b', String(book.year)), 'published') : null,
        book.genre ? h('div', h('b', book.genre), 'genre') : null,
        h('div', h('b', formatBytes(book.size)), 'on disk')),

      book.description ? h('p.detail__blurb', book.description) : null,

      h('section.section', { style: { marginTop: '30px' } },
        sectionHead(book.chapters.length ? 'Chapters' : 'Files'), chapterList),
      h('section.section', sectionHead('Bookmarks'), bookmarkList)));
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------
export async function downloadsView(ctx) {
  const node = h('div');
  const list = h('div.list');
  const summary = h('p.tag');

  async function render() {
    const entries = Object.values(downloadIndex()).sort((a, b) => b.savedAt - a.savedAt);
    const usage = await storageUsage();
    summary.textContent = usage.quota
      ? `${entries.length} book${entries.length === 1 ? '' : 's'} · ${formatBytes(usage.bytes)} of ${formatBytes(usage.quota.quota)} available`
      : `${entries.length} book${entries.length === 1 ? '' : 's'} · ${formatBytes(usage.bytes)}`;

    mount(list, entries.length ? entries.map((entry) => h('div.list__row',
      h('span.list__num', icon('check', 16)),
      h('a.list__name', { href: `#/book/${entry.id}` }, entry.title, ' — ', entry.author || 'Unknown'),
      h('span.list__time', formatBytes(entry.bytes)),
      h('button.iconbtn', {
        title: 'Remove download',
        onclick: async () => { await removeDownload(entry.id); render(); toast('Download removed'); },
      }, icon('trash', 16))))
      : emptyState('Nothing saved offline',
        h('p', 'Open a book and hit Download to keep it on this device — handy for flights and the subway.')));
  }

  node.append(h('header.topbar',
    h('div', h('p.eyebrow', 'On this device'), h('h1', 'Downloads')),
    h('button.btn.btn--danger', {
      onclick: async () => { await clearAllDownloads(); render(); toast('All downloads cleared'); },
    }, icon('trash'), 'Clear all')));
  node.append(summary, list);
  await render();
  return node;
}

// ---------------------------------------------------------------------------
// Settings (account, playback, admin)
// ---------------------------------------------------------------------------
export async function settingsView(ctx) {
  const node = h('div');
  node.append(h('header.topbar', h('div', h('p.eyebrow', 'Preferences'), h('h1', 'Settings'))));

  // --- appearance & playback
  const themeButtons = h('div.chips', ...[['night', 'Night'], ['daylight', 'Daylight']].map(([value, label]) =>
    h('button.chip', {
      type: 'button',
      'aria-pressed': String(ctx.theme() === value),
      onclick: (event) => {
        ctx.setTheme(value);
        [...event.target.parentElement.children].forEach((chip) =>
          chip.setAttribute('aria-pressed', String(chip === event.target)));
      },
    }, label)));

  const speedRow = h('div.speeddial', ...[0.8, 1, 1.15, 1.25, 1.5, 1.75, 2].map((speed) =>
    h('button.chip', {
      type: 'button',
      'aria-pressed': String(ctx.player.speed === speed),
      onclick: (event) => {
        ctx.player.setSpeed(speed);
        [...event.target.parentElement.children].forEach((chip) =>
          chip.setAttribute('aria-pressed', String(chip === event.target)));
      },
    }, `${speed}×`)));

  node.append(h('section.section',
    sectionHead('Look and feel'),
    h('div.settingrow',
      h('div', h('div.settingrow__label', 'Theme'), h('div.settingrow__hint', 'Night is easier on the eyes at 2am.')),
      themeButtons),
    h('div.settingrow',
      h('div', h('div.settingrow__label', 'Default speed'), h('div.settingrow__hint', 'Applies to books you have not set a speed for.')),
      speedRow)));

  // --- account
  const passwordError = h('p.formerror');
  const passwordForm = h('form.form', {
    onsubmit: async (event) => {
      event.preventDefault();
      passwordError.textContent = '';
      const data = new FormData(event.target);
      try {
        await api.changePassword(data.get('current'), data.get('next'));
        event.target.reset();
        toast('Password changed — other devices signed out');
      } catch (err) {
        passwordError.textContent = err.message;
      }
    },
  },
    h('label', 'Current password', h('input', { name: 'current', type: 'password', required: true, autocomplete: 'current-password' })),
    h('label', 'New password', h('input', { name: 'next', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' })),
    passwordError,
    h('div', h('button.btn', { type: 'submit' }, 'Change password')));

  node.append(h('section.section',
    sectionHead('Account'),
    h('div.settingrow',
      h('div', h('div.settingrow__label', ctx.user.displayName),
        h('div.settingrow__hint', `@${ctx.user.username}${ctx.user.isAdmin ? ' · administrator' : ''}`)),
      h('button.btn.btn--ghost', { onclick: ctx.signOut }, icon('logout'), 'Sign out')),
    passwordForm));

  if (ctx.user.isAdmin) node.append(await adminSection(ctx));
  return node;
}

async function adminSection(ctx) {
  const wrap = h('section.section');
  const status = h('div');

  async function render() {
    const data = await api.adminStatus();
    const scan = data.scan;
    const scanning = scan.running;

    mount(status,
      h('div.settingrow',
        h('div',
          h('div.settingrow__label', 'Library folder'),
          h('div.settingrow__hint', h('code', data.library.path))),
        h('div.chips',
          h('button.btn', {
            disabled: scanning,
            onclick: async () => { await api.scan(false); toast('Scan started'); poll(); },
          }, icon('refresh'), scanning ? 'Scanning…' : 'Scan now'),
          h('button.btn.btn--ghost', {
            disabled: scanning,
            title: 'Re-read tags for every book, even unchanged ones',
            onclick: async () => { await api.scan(true); toast('Full re-scan started'); poll(); },
          }, 'Force re-scan'))),

      h('div.settingrow',
        h('div',
          h('div.settingrow__label', `${data.library.books} books · ${data.library.tracks} files`),
          h('div.settingrow__hint', scanning
            ? `Scanning ${scan.processed}/${scan.found} — ${scan.current || ''}`
            : scan.finishedAt
              ? `Last scan ${relativeTime(scan.finishedAt)} · +${scan.added} added, ${scan.updated} updated, ${scan.removed} removed`
              : 'No scan yet')),
        h('span.tag', formatBytes(data.library.size))),

      scan.error ? h('p.formerror', scan.error) : null,

      h('div.tablewrap', h('table',
        h('thead', h('tr', h('th', 'User'), h('th', 'Role'), h('th', 'Added'), h('th', ''))),
        h('tbody', ...data.users.map((user) => h('tr',
          h('td', h('b', user.displayName), ' ', h('span.tag', `@${user.username}`)),
          h('td', user.isAdmin ? 'Administrator' : 'Listener'),
          h('td', relativeTime(user.createdAt)),
          h('td', user.id === ctx.user.id ? h('span.tag', 'you') : h('button.iconbtn', {
            title: `Remove ${user.username}`,
            onclick: async () => {
              if (!confirm(`Remove ${user.username}? Their listening history goes too.`)) return;
              await api.deleteUser(user.id);
              render();
            },
          }, icon('trash', 16)))))))),

      newUserForm());
  }

  function newUserForm() {
    const error = h('p.formerror');
    return h('form.form', {
      onsubmit: async (event) => {
        event.preventDefault();
        error.textContent = '';
        const data = new FormData(event.target);
        try {
          await api.addUser({
            username: data.get('username'),
            displayName: data.get('displayName'),
            password: data.get('password'),
            isAdmin: data.get('isAdmin') === 'on',
          });
          event.target.reset();
          toast('Listener added');
          render();
        } catch (err) {
          error.textContent = err.message;
        }
      },
    },
      h('h3', { style: { fontFamily: 'var(--display)' } }, 'Add a listener'),
      h('label', 'Username', h('input', { name: 'username', required: true, autocomplete: 'off' })),
      h('label', 'Display name', h('input', { name: 'displayName', autocomplete: 'off' })),
      h('label', 'Password', h('input', { name: 'password', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' })),
      h('label', { style: { flexDirection: 'row', alignItems: 'center', gap: '8px', display: 'flex' } },
        h('input', { name: 'isAdmin', type: 'checkbox', style: { width: 'auto' } }), 'Administrator'),
      error,
      h('div', h('button.btn', { type: 'submit' }, 'Create account')));
  }

  let pollTimer = null;
  function poll() {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      const data = await api.adminStatus().catch(() => null);
      if (!data || !data.scan.running) {
        clearInterval(pollTimer);
        render();
        if (data) toast(`Scan done · ${data.library.books} books`);
      } else {
        render();
      }
    }, 1200);
    ctx.onLeave(() => clearInterval(pollTimer));
  }

  wrap.append(sectionHead('Server'), status);
  await render();
  return wrap;
}
