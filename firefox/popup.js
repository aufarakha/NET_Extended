const STORAGE_KEY = 'notionEmptyTrashEnabled';
const extensionApi = typeof browser !== 'undefined' ? browser : chrome;

const toggle = document.getElementById('enabledToggle');
const statusCard = document.getElementById('statusCard');
const statusLabel = document.getElementById('statusLabel');
const statusCopy = document.getElementById('statusCopy');

function storageGet(defaults) {
  try {
    const maybePromise = extensionApi.storage.local.get(defaults);
    if (maybePromise?.then) return maybePromise;
  } catch (_) {
    // Some Chromium builds expose callback-only extension storage.
  }

  return new Promise((resolve) => {
    extensionApi.storage.local.get(defaults, (data) => resolve(data || defaults));
  });
}

function storageSet(values) {
  try {
    const maybePromise = extensionApi.storage.local.set(values);
    if (maybePromise?.then) return maybePromise;
  } catch (_) {
    // Some Chromium builds expose callback-only extension storage.
  }

  return new Promise((resolve) => {
    extensionApi.storage.local.set(values, resolve);
  });
}

function render(enabled) {
  toggle.checked = enabled;
  statusCard.classList.toggle('is-active', enabled);
  statusLabel.textContent = enabled ? 'Aktif' : 'Nonaktif';
  statusCopy.textContent = enabled ? 'Tombol menu Trash tampil' : 'Tombol menu Trash disembunyikan';
}

async function init() {
  const data = await storageGet({ [STORAGE_KEY]: true });
  render(data[STORAGE_KEY] !== false);

  toggle.addEventListener('change', async () => {
    const enabled = toggle.checked;
    render(enabled);
    await storageSet({ [STORAGE_KEY]: enabled });
  });
}

init();
