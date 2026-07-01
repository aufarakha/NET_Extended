(() => {
  if (window.__notionEmptyTrashInlineV2Installed) return;
  window.__notionEmptyTrashInlineV2Installed = true;

  const CONFIG = {
    SEARCH_LIMIT: 100,
    DELETE_BATCH_SIZE: 20,
    BUTTON_ID: 'notion-empty-trash-inline-button-v2',
    STORAGE_KEY: 'notionEmptyTrashEnabled',
    LOG_PREFIX: '[Notion Empty Trash]'
  };

  const log = (...args) => console.log(CONFIG.LOG_PREFIX, ...args);
  const warn = (...args) => console.warn(CONFIG.LOG_PREFIX, ...args);
  let extensionEnabled = true;

  function isNotionPage() {
    return /(^|\.)notion\.(so|com)$/.test(location.hostname) || location.hostname === 'app.notion.com';
  }

  if (!isNotionPage()) return;

  function getExtensionApi() {
    if (typeof browser !== 'undefined') return browser;
    if (typeof chrome !== 'undefined') return chrome;
    return null;
  }

  async function readEnabledSetting() {
    const api = getExtensionApi();
    if (!api?.storage?.local) return true;

    try {
      const maybePromise = api.storage.local.get({ [CONFIG.STORAGE_KEY]: true });
      if (maybePromise?.then) {
        const data = await maybePromise;
        return data?.[CONFIG.STORAGE_KEY] !== false;
      }
    } catch (_) {
      // Some Chromium builds expose callback-only extension storage.
    }

    return new Promise((resolve) => {
      try {
        api.storage.local.get({ [CONFIG.STORAGE_KEY]: true }, (data) => {
          const runtimeError = api.runtime?.lastError;
          if (runtimeError) warn('Could not read extension setting', runtimeError);
          resolve(data?.[CONFIG.STORAGE_KEY] !== false);
        });
      } catch (err) {
        warn('Could not read extension setting', err);
        resolve(true);
      }
    });
  }

  function watchEnabledSetting() {
    const api = getExtensionApi();
    if (!api?.storage?.onChanged) return;

    api.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes[CONFIG.STORAGE_KEY]) return;
      setExtensionEnabled(changes[CONFIG.STORAGE_KEY].newValue !== false);
    });
  }

  function getCookie(name) {
    const escaped = name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&');
    const match = document.cookie.match(new RegExp('(?:^|; )' + escaped + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : null;
  }

  function standardizeUUID(id) {
    if (!id) return null;
    const clean = String(id).replace(/-/g, '');
    if (!/^[a-f0-9]{32}$/i.test(clean)) return null;
    return clean.replace(
      /([a-f0-9]{8})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{12})/i,
      '$1-$2-$3-$4-$5'
    );
  }

  function generateUUID() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function getCurrentPageId() {
    const compactMatch = location.href.match(/[a-f0-9]{32}/i);
    if (compactMatch?.[0]) return standardizeUUID(compactMatch[0]);

    const dashedMatch = location.href.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
    if (dashedMatch?.[0]) return standardizeUUID(dashedMatch[0]);

    return null;
  }

  function getUserId() {
    const fromCookie = getCookie('notion_user_id');
    if (fromCookie) return standardizeUUID(fromCookie);

    const syncUserCookie = getCookie('notion_sync_user_id');
    if (syncUserCookie) {
      try {
        const parsed = JSON.parse(syncUserCookie);
        if (parsed?.notion_user_id) return standardizeUUID(parsed.notion_user_id);
      } catch (err) {
        warn('Could not parse notion_sync_user_id cookie', err);
      }
    }

    const pSync = getCookie('p_sync_session');
    if (pSync) {
      try {
        const parsed = JSON.parse(pSync);
        const first = parsed?.userIds?.[0];
        if (first) return standardizeUUID(first);
      } catch (err) {
        warn('Could not parse p_sync_session cookie', err);
      }
    }

    return null;
  }

  function endpoint(path) {
    return location.origin.replace(/\/$/, '') + path;
  }

  async function rawNotionFetch(path, body, extraHeaders = {}) {
    const resp = await fetch(endpoint(path), {
      method: 'POST',
      mode: 'cors',
      credentials: 'include',
      headers: {
        accept: '*/*',
        'content-type': 'application/json',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });

    const text = await resp.text();
    let json = null;

    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      warn('Response is not JSON:', text);
    }

    if (!resp.ok) {
      warn('Request failed', { path, status: resp.status, body, responseText: text, responseJson: json });
      throw new Error(path + ' failed with status ' + resp.status);
    }

    return json;
  }

  function findSpaceIdInRecordMap(recordMap) {
    const blockMap = recordMap?.block || {};
    for (const key of Object.keys(blockMap)) {
      const block = blockMap[key];
      const possibleSpaceId =
        block?.value?.value?.space_id ||
        block?.value?.value?.spaceId ||
        block?.value?.space_id ||
        block?.spaceId;
      const spaceId = standardizeUUID(possibleSpaceId);
      if (spaceId) return spaceId;
    }
    return null;
  }

  async function getSpaceIdFromCurrentPage(userId) {
    const pageId = getCurrentPageId();
    if (!pageId) return null;

    const headers = {};
    if (userId) headers['x-notion-active-user-header'] = userId;

    const payloads = [
      { pageId, limit: 50, cursor: { stack: [] }, chunkNumber: 0, verticalColumns: false },
      { pageId: pageId.replace(/-/g, ''), limit: 50, cursor: { stack: [] }, chunkNumber: 0, verticalColumns: false },
    ];

    for (const payload of payloads) {
      try {
        const json = await rawNotionFetch('/api/v3/loadPageChunk', payload, headers);
        const spaceId = findSpaceIdInRecordMap(json?.recordMap);
        if (spaceId) return spaceId;
      } catch (err) {
        warn('loadPageChunk failed', err);
      }
    }
    return null;
  }

  function getSpaceIdFromLocalStorage() {
    const patterns = [
      /"space_id"\s*:\s*"([a-f0-9-]{32,36})"/i,
      /"spaceId"\s*:\s*"([a-f0-9-]{32,36})"/i,
    ];

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const value = localStorage.getItem(key);
      if (!value) continue;
      for (const pattern of patterns) {
        const match = value.match(pattern);
        if (match?.[1]) {
          const spaceId = standardizeUUID(match[1]);
          if (spaceId) return spaceId;
        }
      }
    }
    return null;
  }

  async function detectNotionContext() {
    let userId = getUserId();
    if (!userId) {
      const manualUserId = prompt('Gagal detect USER_ID otomatis. Masukkan Notion user ID:');
      userId = standardizeUUID(manualUserId);
    }

    let spaceId = await getSpaceIdFromCurrentPage(userId);
    if (!spaceId) spaceId = getSpaceIdFromLocalStorage();

    if (!spaceId) {
      const manualSpaceId = prompt('Gagal detect SPACE_ID otomatis. Buka salah satu page di workspace ini, lalu coba lagi.\n\nAtau masukkan Notion space ID:');
      spaceId = standardizeUUID(manualSpaceId);
    }

    if (!userId || !spaceId) throw new Error('USER_ID atau SPACE_ID tidak ditemukan.');
    return { userId, spaceId };
  }

  async function fetchNotion(path, body, context) {
    return rawNotionFetch(path, body, {
      'x-notion-active-user-header': context.userId,
      'x-notion-space-id': context.spaceId,
    });
  }

  function getRecentPagesForBoosting() {
    const ids = new Set();
    const urlMatches = location.href.match(/[a-f0-9]{32}/gi) || [];
    for (const rawId of urlMatches) {
      const pageId = standardizeUUID(rawId);
      if (pageId) ids.add(pageId);
    }
    return [...ids].map((pageId) => ({ visitedAt: Date.now(), pageId }));
  }

  async function searchTrash(context) {
    const body = {
      type: 'BlocksInSpace',
      query: '',
      limit: CONFIG.SEARCH_LIMIT,
      filters: {
        isDeletedOnly: true,
        excludeTemplates: false,
        navigableBlockContentOnly: true,
        requireEditPermissions: false,
        includePublicPagesWithoutExplicitAccess: false,
        ancestors: [],
        createdBy: [],
        editedBy: [context.userId],
        lastEditedTime: {},
        createdTime: {},
        inTeams: [],
        excludeSurrogateCollections: false,
        excludedParentCollectionIds: [],
      },
      sort: { field: 'lastEdited', direction: 'desc' },
      source: 'trash',
      peopleBlocksToInclude: 'person_profiles',
      spaceId: context.spaceId,
      excludedBlockIds: [],
      searchSessionFlowNumber: 1,
      searchSessionId: generateUUID(),
      recentPagesForBoosting: getRecentPagesForBoosting(),
      ignoresHighlight: true,
    };

    const json = await fetchNotion('/api/v3/search', body, context);
    const idsFromResults = (json?.results || []).map((item) => item?.id).filter(Boolean);
    const idsFromTrackEvent = json?.trackEventProperties?.resultIds?.filter(Boolean) || [];
    return [...new Set([...idsFromResults, ...idsFromTrackEvent])];
  }

  async function permanentlyDeleteRecords(blockIds, context) {
    const body = {
      records: blockIds.map((id) => ({ table: 'block', id, spaceId: context.spaceId })),
      permanentlyDelete: true,
    };
    return fetchNotion('/api/v3/deleteContentRecords', body, context);
  }

  async function emptyTrash(button) {
    if (!extensionEnabled) {
      alert('NET_Extended sedang nonaktif.');
      return;
    }

    if (window.__notionEmptyTrashRunning) {
      alert('Notion Empty Trash sedang berjalan.');
      return;
    }

    window.__notionEmptyTrashRunning = true;
    const originalText = button?.textContent || 'Empty Trash';
    if (button) {
      button.disabled = true;
      button.textContent = 'Checking Trash...';
    }

    try {
      const context = await detectNotionContext();
      log('Detected context', context);
      const blockIds = await searchTrash(context);
      log('Found trash IDs', blockIds);

      if (!blockIds.length) {
        alert('Trash kosong, atau tidak ada item yang bisa dihapus.');
        return;
      }

      const confirmed = confirm(
        'Akan menghapus permanen ' +
          blockIds.length +
          ' item dari Notion Trash.\n\nWorkspace ID:\n' +
          context.spaceId +
          '\n\nIni tidak bisa di-undo. Lanjut?'
      );
      if (!confirmed) return;

      let deletedCount = 0;
      for (let i = 0; i < blockIds.length; i += CONFIG.DELETE_BATCH_SIZE) {
        const batch = blockIds.slice(i, i + CONFIG.DELETE_BATCH_SIZE);
        if (button) button.textContent = 'Deleting ' + Math.min(i + batch.length, blockIds.length) + '/' + blockIds.length + '...';
        await permanentlyDeleteRecords(batch, context);
        deletedCount += batch.length;
      }

      alert('Selesai. Terhapus permanen: ' + deletedCount + ' item.');
    } catch (err) {
      console.error(CONFIG.LOG_PREFIX, err);
      alert('Gagal empty trash: ' + (err?.message || String(err)) + '\nCek console untuk detail.');
    } finally {
      window.__notionEmptyTrashRunning = false;
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
  }

  function styleMenuButton(button) {
    Object.assign(button.style, {
      width: '100%',
      padding: '8px 12px',
      margin: '4px 0',
      border: 'none',
      borderRadius: '6px',
      cursor: 'pointer',
      textAlign: 'left',
      background: 'transparent',
      color: 'inherit',
      fontSize: '14px',
      fontFamily: 'inherit',
      display: 'block',
    });
  }

  function wireButton(button) {
    if (button.__notionEmptyTrashWired) return;
    button.__notionEmptyTrashWired = true;
    button.addEventListener('mouseenter', () => {
      if (!button.disabled) button.style.background = 'rgba(55, 53, 47, 0.08)';
    });
    button.addEventListener('mouseleave', () => {
      button.style.background = 'transparent';
    });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      emptyTrash(button);
    });
  }

  function makeButton(id, text) {
    const button = document.createElement('button');
    button.id = id;
    button.type = 'button';
    button.textContent = text;
    button.setAttribute('aria-label', 'Empty Notion Trash permanently');
    styleMenuButton(button);
    wireButton(button);
    return button;
  }

  function injectIntoTrashMenu(menu) {
    if (!menu || menu.querySelector('#' + CONFIG.BUTTON_ID)) return false;
    const button = makeButton(CONFIG.BUTTON_ID, 'Empty Trash');
    const secondChild = menu.children[1] || null;
    menu.insertBefore(button, secondChild);
    log('Injected button into trash menu');
    return true;
  }

  function isProbablyTrashMenu(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el.classList.contains('notion-sidebar-trash-menu')) return true;

    const text = (el.innerText || el.textContent || '').trim();
    if (!text || text.length > 2000) return false;

    const lower = text.toLowerCase();
    const hasTrashWords = lower.includes('trash') || lower.includes('deleted') || lower.includes('restore');
    const looksLikeMenu =
      el.getAttribute('role') === 'menu' ||
      el.getAttribute('role') === 'dialog' ||
      el.style.position === 'fixed' ||
      el.style.position === 'absolute' ||
      el.closest('[role="dialog"]') === el;

    return hasTrashWords && looksLikeMenu;
  }

  function injectIntoOpenMenus() {
    let injected = false;

    document.querySelectorAll('.notion-sidebar-trash-menu').forEach((el) => {
      if (injectIntoTrashMenu(el)) injected = true;
    });

    const candidates = document.querySelectorAll('[role="menu"], [role="dialog"], div[style*="position: fixed"], div[style*="position: absolute"]');
    candidates.forEach((el) => {
      if (isProbablyTrashMenu(el)) {
        if (injectIntoTrashMenu(el)) injected = true;
      }
    });

    return injected;
  }

  function removeInlineButton() {
    document.querySelectorAll('#' + CONFIG.BUTTON_ID).forEach((button) => button.remove());
  }

  function scanAndInject() {
    if (!extensionEnabled) {
      removeInlineButton();
      return;
    }

    injectIntoOpenMenus();
  }

  function setExtensionEnabled(enabled) {
    extensionEnabled = enabled;
    if (extensionEnabled) scanAndInject();
    else removeInlineButton();
  }

  async function start() {
    extensionEnabled = await readEnabledSetting();
    scanAndInject();
    const observer = new MutationObserver(() => scanAndInject());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(scanAndInject, 1000);
    watchEnabledSetting();
    window.emptyNotionTrash = () => emptyTrash(document.getElementById(CONFIG.BUTTON_ID));
    log('Inline extension loaded. Open Notion Trash menu, or run emptyNotionTrash().');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
