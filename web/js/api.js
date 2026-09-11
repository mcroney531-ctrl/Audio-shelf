class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      signal,
      credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new ApiError(0, 'Cannot reach the server');
  }
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new ApiError(response.status, data.error || response.statusText);
  return data;
}

const query = (params = {}) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, value);
  }
  const string = search.toString();
  return string ? `?${string}` : '';
};

export const api = {
  ApiError,
  setupState: () => request('/api/setup'),
  setup: (payload) => request('/api/setup', { method: 'POST', body: payload }),
  login: (username, password) => request('/api/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  me: () => request('/api/me'),
  changePassword: (currentPassword, newPassword) =>
    request('/api/me/password', { method: 'POST', body: { currentPassword, newPassword } }),

  shelves: () => request('/api/shelves'),
  books: (params) => request(`/api/books${query(params)}`),
  book: (id) => request(`/api/books/${id}`),
  progress: () => request('/api/progress'),
  saveProgress: (bookId, payload) => request(`/api/books/${bookId}/progress`, { method: 'PUT', body: payload }),
  addBookmark: (bookId, payload) => request(`/api/books/${bookId}/bookmarks`, { method: 'POST', body: payload }),
  deleteBookmark: (id) => request(`/api/bookmarks/${id}`, { method: 'DELETE' }),

  adminStatus: () => request('/api/admin/status'),
  tokens: () => request('/api/me/tokens'),
  createToken: (label) => request('/api/me/tokens', { method: 'POST', body: { label } }),
  revokeToken: (id) => request(`/api/me/tokens/${id}`, { method: 'DELETE' }),
  imports: () => request('/api/admin/imports'),
  convertImport: (id, keys = {}) => request(`/api/admin/imports/${id}/convert`, { method: 'POST', body: keys }),
  importChecksum: (id) => request(`/api/admin/imports/${id}/checksum`),
  forgetImport: (id) => request(`/api/admin/imports/${id}`, { method: 'DELETE' }),
  setActivationBytes: (activationBytes) =>
    request('/api/admin/activation', { method: 'POST', body: { activationBytes } }),
  clearActivationBytes: () => request('/api/admin/activation', { method: 'POST', body: { clear: true } }),
  tts: () => request('/api/admin/tts'),
  ttsVoices: (language = 'en-US') => request(`/api/admin/tts/voices${query({ language })}`),
  ttsEstimate: (text, voice) => request('/api/admin/tts/estimate', { method: 'POST', body: { text, voice } }),
  ttsGenerate: (payload) => request('/api/admin/tts/generate', { method: 'POST', body: payload }),
  ttsRetry: (id) => request(`/api/admin/tts/${id}/retry`, { method: 'POST' }),
  ttsCancel: (id) => request(`/api/admin/tts/${id}/cancel`, { method: 'POST' }),
  ttsForget: (id) => request(`/api/admin/tts/${id}`, { method: 'DELETE' }),
  setTtsKey: (payload) => request('/api/admin/tts/credentials', { method: 'POST', body: payload }),
  clearTtsKey: () => request('/api/admin/tts/credentials', { method: 'POST', body: { clear: true } }),

  scan: (force = false) => request('/api/admin/scan', { method: 'POST', body: { force } }),
  addUser: (payload) => request('/api/admin/users', { method: 'POST', body: payload }),
  deleteUser: (id) => request(`/api/admin/users/${id}`, { method: 'DELETE' }),
};

/**
 * Uploads use XHR rather than fetch: fetch still cannot report upload progress,
 * and a 900 MB book with no progress bar feels broken.
 */
export const uploadFile = (file, { folder = '', onProgress, signal } = {}) => new Promise((resolve, reject) => {
  const xhr = new XMLHttpRequest();
  const query = new URLSearchParams({ name: file.name, folder });
  xhr.open('POST', `/api/upload?${query}`);
  xhr.withCredentials = true;
  xhr.upload.addEventListener('progress', (event) => {
    if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total, event.loaded);
  });
  xhr.addEventListener('load', () => {
    let data = {};
    try { data = JSON.parse(xhr.responseText || '{}'); } catch { /* non-JSON error page */ }
    if (xhr.status >= 200 && xhr.status < 300) resolve(data.file);
    else reject(new ApiError(xhr.status, data.error || `Upload failed (${xhr.status})`));
  });
  xhr.addEventListener('error', () => reject(new ApiError(0, 'Upload failed — is the server still running?')));
  xhr.addEventListener('abort', () => reject(new ApiError(0, 'Upload cancelled')));
  signal?.addEventListener('abort', () => xhr.abort());
  xhr.send(file);
});

export const coverUrl = (book) => (book.hasCover ? `/api/books/${book.id}/cover` : null);
export const trackUrl = (trackId) => `/api/tracks/${trackId}/stream`;
