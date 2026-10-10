// gallery.html: the public gallery, newest first, with Load more.
import { mountGallery } from './gallery-cards.js';

mountGallery(document.querySelector('[data-gallery]'), { appUrl: document.documentElement.dataset.appUrl });
