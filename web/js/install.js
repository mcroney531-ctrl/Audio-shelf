/**
 * Everything to do with becoming a real installed app on Android/iOS/desktop.
 *
 * Android only mints a WebAPK (a genuine app with its own icon, app-drawer
 * entry and OS identity) when Chrome's installability criteria are met. If they
 * are not, "Add to Home screen" silently drops a bookmark shortcut with a
 * Chrome badge on the icon instead — so the app verifies the criteria itself
 * and reports exactly which one is missing.
 */

let deferredPrompt = null;
let promptSeen = false;

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();          // keep the mini-infobar from firing on its own
  deferredPrompt = event;
  promptSeen = true;
  document.dispatchEvent(new CustomEvent('audioshelf:installable'));
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  document.dispatchEvent(new CustomEvent('audioshelf:installed'));
});

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches
  || window.matchMedia('(display-mode: fullscreen)').matches
  || window.navigator.standalone === true;

export const canPrompt = () => Boolean(deferredPrompt);

/** Returns 'accepted', 'dismissed', or 'unavailable'. */
export async function promptInstall() {
  if (!deferredPrompt) return 'unavailable';
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;
  return outcome;
}

const ok = (label, detail) => ({ label, ok: true, detail });
const bad = (label, detail, fix) => ({ label, ok: false, detail, fix });

async function reachable(url) {
  try {
    const response = await fetch(url, { method: 'GET', credentials: 'same-origin' });
    return { ok: response.ok, type: response.headers.get('content-type') || '' };
  } catch {
    return { ok: false, type: '' };
  }
}

/**
 * Runs the same checks Chrome runs, in the same order, and says what to fix.
 * Use this before telling anyone "just add it to your home screen".
 */
export async function runInstallChecks() {
  const checks = [];

  checks.push(window.isSecureContext
    ? ok('Secure context', location.protocol === 'https:' ? 'Served over HTTPS' : 'Running on localhost')
    : bad('Secure context', `Served over ${location.protocol.replace(':', '')}`,
      'Android will not install an app from plain HTTP. Put AudioShelf behind a reverse proxy with a certificate (or reach it over a tunnel that terminates TLS).'));

  const link = document.querySelector('link[rel=manifest]');
  checks.push(link
    ? ok('Manifest linked', link.getAttribute('href'))
    : bad('Manifest linked', 'No <link rel="manifest"> in the page head', 'Add the manifest link tag to index.html.'));

  let manifest = null;
  if (link) {
    try {
      const response = await fetch(link.href, { credentials: 'same-origin' });
      manifest = await response.json();
      const type = response.headers.get('content-type') || '';
      checks.push(response.ok
        ? ok('Manifest fetched', `${response.status} · ${type.split(';')[0] || 'no content-type'}`)
        : bad('Manifest fetched', `HTTP ${response.status}`, 'The manifest must be reachable from the app scope.'));
    } catch (err) {
      checks.push(bad('Manifest fetched', err.message, 'The manifest must be valid JSON served from the same origin.'));
    }
  }

  if (manifest) {
    const missing = ['name', 'short_name', 'start_url'].filter((field) => !manifest[field]);
    checks.push(missing.length
      ? bad('Required fields', `Missing: ${missing.join(', ')}`, 'Add the missing keys to the manifest.')
      : ok('Required fields', `${manifest.name} · start_url ${manifest.start_url}`));

    const display = manifest.display || 'browser';
    checks.push(['standalone', 'fullscreen', 'minimal-ui'].includes(display)
      ? ok('Display mode', display)
      : bad('Display mode', display, 'Set "display": "standalone" — "browser" is not installable.'));

    const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
    const purposes = (entry) => String(entry.purpose || 'any').trim().split(/\s+/);
    const combined = icons.filter((entry) => purposes(entry).length > 1);
    const sized = (list, size) => list.some((entry) => String(entry.sizes || '').split(/\s+/).includes(`${size}x${size}`));
    const anyIcons = icons.filter((entry) => purposes(entry).includes('any'));
    const maskIcons = icons.filter((entry) => purposes(entry).includes('maskable'));

    checks.push(combined.length
      ? bad('Icon purposes are separate', `${combined.length} entry/entries use a combined purpose`,
        'Never write "any maskable" on one entry: Chrome\'s WebAPK icon resolution can fail on it and fall back to a bookmark shortcut. List separate entries per purpose.')
      : ok('Icon purposes are separate', 'No combined "any maskable" entries'));

    checks.push(sized(anyIcons, 192) && sized(anyIcons, 512)
      ? ok('Standard icons', '192 and 512 present with purpose "any"')
      : bad('Standard icons', 'Need purpose "any" PNGs at both 192x192 and 512x512',
        'Add both sizes; Chrome needs a 192 for the launcher and a 512 for the splash screen.'));

    checks.push(sized(maskIcons, 192) && sized(maskIcons, 512)
      ? ok('Maskable icons', '192 and 512 present with purpose "maskable"')
      : bad('Maskable icons', 'Need purpose "maskable" PNGs at both 192x192 and 512x512',
        'Add dedicated maskable assets with the mark inside the inner 80% safe zone, or Android will crop it.'));

    const results = await Promise.all(icons.slice(0, 8).map(async (entry) => ({
      entry, result: await reachable(new URL(entry.src, location.origin).href),
    })));
    const broken = results.filter(({ result }) => !result.ok || !result.type.startsWith('image/'));
    checks.push(broken.length
      ? bad('Icon files load', `${broken.length} icon(s) missing or not an image`, `Check: ${broken.map(({ entry }) => entry.src).join(', ')}`)
      : ok('Icon files load', `${results.length} icon${results.length === 1 ? '' : 's'} served as images`));
  }

  if ('serviceWorker' in navigator) {
    const registration = await navigator.serviceWorker.getRegistration('/');
    const controlled = Boolean(navigator.serviceWorker.controller);
    checks.push(registration
      ? (controlled
        ? ok('Service worker', `Active and controlling · scope ${registration.scope}`)
        : bad('Service worker', 'Registered but not controlling this page yet', 'Reload once — the worker takes control on the next navigation.'))
      : bad('Service worker', 'Not registered', 'Installability requires an active service worker registration for the page scope.'));
  } else {
    checks.push(bad('Service worker', 'Not supported by this browser', 'Use Chrome, Edge, Safari 16.4+ or Firefox for the installable experience.'));
  }

  checks.push(isStandalone()
    ? ok('Install state', 'Running as an installed app')
    : canPrompt()
      ? ok('Install state', 'Chrome has offered to install — use the button above')
      : bad('Install state', promptSeen ? 'The install prompt was already used' : 'No install prompt offered yet',
        'On Android, browse the site for a few seconds and check Chrome\'s ⋮ menu: it must say "Install app", not "Add to Home screen". On iOS, use Share → Add to Home Screen (Safari never fires an install prompt).'));

  return checks;
}

export const installReport = (checks) =>
  checks.map((check) => `${check.ok ? 'PASS' : 'FAIL'}  ${check.label} — ${check.detail}${check.fix ? `\n      fix: ${check.fix}` : ''}`).join('\n');
