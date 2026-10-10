// The landing's Gallery section: the newest six layouts, fetched when the section nears the screen (a gallery page can
// carry up to 48 thumbnails, so a visitor who never scrolls there never downloads it).
import { mountStrip } from './gallery-cards.js';

const root = document.querySelector('[data-gallery-strip-wrap]');
if (root) {
  const watch = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting)) return;
    watch.disconnect();
    mountStrip(root, { count: 6 });
  }, { rootMargin: '800px 0px' });
  watch.observe(root);
}
