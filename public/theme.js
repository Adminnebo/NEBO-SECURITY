/* Display preference only: no document, token or secret is stored here. */
(() => {
  'use strict';
  const storageKey = 'nebo-security-theme';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const valid = value => value === 'light' || value === 'dark' ? value : null;
  let preference = null;
  try { preference = valid(localStorage.getItem(storageKey)); } catch (_) {}

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#171819' : '#f6f5f2');
    const button = document.getElementById('themeToggle');
    if (!button) return;
    const label = theme === 'dark' ? 'Claro' : 'Oscuro';
    document.getElementById('themeToggleLabel').textContent = label;
    button.setAttribute('aria-label', `Cambiar a modo ${label.toLowerCase()}`);
    button.setAttribute('aria-pressed', String(theme === 'dark'));
    button.title = `Cambiar a modo ${label.toLowerCase()}`;
  }
  const selectedTheme = () => preference || (system.matches ? 'dark' : 'light');
  applyTheme(selectedTheme());
  document.addEventListener('DOMContentLoaded', () => {
    applyTheme(selectedTheme());
    document.getElementById('themeToggle')?.addEventListener('click', () => {
      preference = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      applyTheme(preference);
      try { localStorage.setItem(storageKey, preference); } catch (_) {}
    });
  }, { once: true });
  system.addEventListener('change', () => { if (!preference) applyTheme(selectedTheme()); });
  window.addEventListener('storage', event => {
    if (event.key !== storageKey && event.key !== null) return;
    preference = valid(event.newValue);
    applyTheme(selectedTheme());
  });
})();
