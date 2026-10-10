// feedback.html: the feedback form, sent with the site page the visitor came from.
import { mountFeedbackForm, sourcePage } from './feedback-form.js';

const page = sourcePage(document.referrer, location.origin, location.pathname);
document.querySelector('[data-feedback-page]').textContent = page;
mountFeedbackForm(document.querySelector('[data-feedback-form]'), { page, version: 'site' });
