// The landing page's own script (a file, so the Content-Security-Policy allows no inline script).

// Point every app link at <html data-app-url>, plus the link's own `data-app-link` value (`#contribute` opens the
// upload forms); without JS they fall back to their in-page href.
for (const link of document.querySelectorAll('[data-app-link]')) link.href = document.documentElement.dataset.appUrl + link.dataset.appLink;

// The hero's live 3D model loads after the page has painted. The poster image stays for Save-Data, no WebGL or any
// load error; with prefers-reduced-motion the model is shown still (drag still turns it).
const figure = document.querySelector('[data-hero-3d]');
const webgl = (() => { try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; } })();
if (figure && webgl && !navigator.connection?.saveData) {
  const start = () => import('./hero3d.js')
    .then(hero => hero.mountHero(figure, { reduceMotion: matchMedia('(prefers-reduced-motion: reduce)').matches }))
    .catch(error => console.warn('3D hero not shown:', error));
  const idle = () => (window.requestIdleCallback ?? setTimeout)(start, { timeout: 2000 });
  if (document.readyState === 'complete') idle(); else addEventListener('load', idle, { once: true });
}
