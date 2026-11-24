
import { getSupabase } from './supabase.js';
import { getSession, isAdmin, onAuthStateChange, signOut } from './auth.js';

const $ = selector => document.querySelector(selector);

const status = $('#admin-status');
const content = $('#admin-content');
const denied = $('#admin-denied');
const deniedMessage = $('#admin-denied-message');
const view = $('#admin-view');
const search = $('#admin-search');
const signoutButton = $('#admin-signout');
const addTrackButton = $('#add-track-button');
const addArtistButton = $('#add-artist-button');
const addAlbumButton = $('#add-album-button');

const trackModal = $('#track-modal');
const trackForm = $('#track-form');
const trackSaveButton = $('#save-track');
const artistModal = $('#artist-modal');
const artistForm = $('#artist-form');
const artistSaveButton = $('#save-artist');
const albumModal = $('#album-modal');
const albumForm = $('#album-form');
const albumSaveButton = $('#save-album');

// Keep the existing track workflow names local while the admin now manages
// three independently controlled dialogs.
const modal = trackModal;
const form = trackForm;
const saveButton = trackSaveButton;

const state = {
  db: null,
  tracks: [],
  artists: [],
  albums: [],
  genres: [],
  tab: 'overview',
  search: '',
  editingId: null,
  audioDuration: null,
  editingArtistId: null,
  editingAlbumId: null,
  assetUrls: {
    artistImages: new Map(),
    artwork: new Map()
  }
};

const MAX_AUDIO_SIZE = 50 * 1024 * 1024;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/pjpeg',
  'image/png',
  'image/webp',
  'image/avif'
]);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif']);

const AUDIO_EXTENSIONS = new Set(['mp3']);
const AUDIO_TYPES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/x-mp3',
  'audio/x-mpeg-3'
]);

function isAudioFile(file) {
  if (!file || typeof file.name !== 'string') return false;
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  if (!AUDIO_EXTENSIONS.has(extension)) return false;
  if (file.type && !AUDIO_TYPES.has(file.type)) return false;
  return true;
}

const escapeHTML = value =>
  String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);

function duration(seconds) {
  const value = Number(seconds) || 0;

  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

function updateStats() {
  $('#stat-tracks').textContent = state.tracks.length;

  $('#stat-published').textContent =
    state.tracks.filter(track => track.is_published).length;

  $('#stat-artists').textContent = state.artists.length;
  $('#stat-albums').textContent = state.albums.length;
}

function showError(message) {
  status.hidden = false;
  status.className = 'admin-message error';
  status.textContent = message;
}

function setFormMessage(message, isError = false) {
  const element = $('#track-form-message');

  element.textContent = message;
  element.classList.toggle('error', isError);
}

function setDialogMessage(elementId, message, isError = false) {
  const element = $(`#${elementId}`);

  element.textContent = message;
  element.classList.toggle('error', isError);
}

function showSuccess(message) {
  status.hidden = false;
  status.className = 'admin-message';
  status.textContent = message;
}

function shortText(value, limit = 112) {
  const text = String(value ?? '').trim();

  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function imageValidationMessage(file) {
  if (!file) return '';

  const extension = file.name.split('.').pop()?.toLowerCase() || '';

  if (!IMAGE_EXTENSIONS.has(extension) ||
      (file.type && !IMAGE_TYPES.has(file.type))) {
    return 'Choose a JPG, PNG, WEBP or AVIF image.';
  }

  if (file.size > MAX_IMAGE_SIZE) {
    return 'Image exceeds the 5 MB limit.';
  }

  return '';
}

function assetThumbnail(url, label, variant = '') {
  const initial = String(label || '?').trim().charAt(0).toUpperCase() || '?';
  const variantClass = variant === 'artist' ? ' artist' : '';

  return url
    ? `<img class="admin-thumbnail${variantClass}" src="${escapeHTML(url)}" alt="">`
    : `<span class="admin-thumbnail-fallback${variantClass}" aria-hidden="true">${escapeHTML(initial)}</span>`;
}

let currentAdminUserId = undefined;
let adminAuthToken = 0;
let authSubscription = null;

async function signedAssetUrls(bucket, paths, token = adminAuthToken) {
  const uniquePaths = [...new Set(paths.filter(Boolean))];
  const urls = new Map();

  for (let index = 0; index < uniquePaths.length; index += 100) {
    if (token !== adminAuthToken) return urls;
    const batch = uniquePaths.slice(index, index + 100);
    const { data, error } = await state.db?.storage
      ?.from(bucket)
      ?.createSignedUrls(batch, 60 * 60) || {};

    if (token !== adminAuthToken) return urls;
    if (error) {
      console.warn(`Could not sign ${bucket} assets:`, error.message);
      break;
    }

    for (const item of data || []) {
      if (item.path && item.signedUrl) urls.set(item.path, item.signedUrl);
    }
  }

  return urls;
}

async function loadAssetUrls(token = adminAuthToken) {
  try {
    const [artistImages, artwork] = await Promise.all([
      signedAssetUrls(
        'artist-images',
        state.artists.map(artist => artist.image_path),
        token
      ),
      signedAssetUrls('artwork', [
        ...state.albums.map(album => album.cover_path),
        ...state.tracks.map(track => track.cover_path)
      ], token)
    ]);

    if (token !== adminAuthToken) return;

    state.assetUrls.artistImages = artistImages;
    state.assetUrls.artwork = artwork;
  } catch (error) {
    if (token !== adminAuthToken) return;
    console.warn('Could not load admin asset previews:', error);
    state.assetUrls.artistImages = new Map();
    state.assetUrls.artwork = new Map();
  }
}

// LOAD SUPABASE DATA

async function loadData(token = adminAuthToken) {
  if (token !== adminAuthToken) return;
  view.innerHTML = '<p class="admin-loading">Loading catalog…</p>';

  const [
    tracksResult,
    artistsResult,
    albumsResult,
    genresResult
  ] = await Promise.all([
    state.db.from('tracks')
      .select(`
        id,title,artist_id,album_id,genre_id,
        duration_seconds,audio_path,cover_path,
        release_date,is_published,created_at
      `)
      .order('created_at', { ascending: false }),

    state.db.from('artists')
      .select('id,name,bio,image_path,is_published,created_at')
      .order('created_at', { ascending: false }),

    state.db.from('albums')
      .select('id,title,artist_id,cover_path,release_date,is_published,created_at')
      .order('created_at', { ascending: false }),

    state.db.from('genres')
      .select('id,name,slug')
      .order('name')
  ]);

  if (token !== adminAuthToken) return;

  if (tracksResult.error) throw tracksResult.error;
  if (artistsResult.error) throw artistsResult.error;
  if (albumsResult.error) throw albumsResult.error;

  state.tracks = tracksResult.data || [];
  state.artists = artistsResult.data || [];
  state.albums = albumsResult.data || [];

  // Genres are optional.
  if (genresResult.error) {
    console.warn('Genre loading:', genresResult.error.message);
    state.genres = [];
  } else {
    state.genres = genresResult.data || [];
  }

  await loadAssetUrls(token);
  if (token !== adminAuthToken) return;

  updateStats();
  render();
}

// DISPLAY HELPERS

function statusBadge(published) {
  return published
    ? '<span class="admin-status-pill published">Published</span>'
    : '<span class="admin-status-pill unpublished">Unpublished</span>';
}

function actionButton(table, record) {
  return `
    <button
      class="admin-action"
      data-toggle-table="${table}"
      data-toggle-id="${escapeHTML(record.id)}"
      data-toggle-value="${record.is_published ? 'true' : 'false'}">
      ${record.is_published ? 'Unpublish' : 'Publish'}
    </button>
  `;
}

function filtered(items, fields) {
  const term = state.search.trim().toLowerCase();

  if (!term) return items;

  return items.filter(item =>
    fields.some(field =>
      String(item[field] ?? '').toLowerCase().includes(term)
    )
  );
}

function artistName(id) {
  return state.artists.find(item => item.id === id)?.name
    || 'Unknown artist';
}

function albumName(id) {
  return state.albums.find(item => item.id === id)?.title
    || 'Single';
}

function filterTracks(items) {
  const term = state.search.trim().toLowerCase();

  if (!term) return items;

  return items.filter(track => {
    const title = String(track.title ?? '').toLowerCase();
    const artist = String(artistName(track.artist_id) ?? '').toLowerCase();
    const album = String(albumName(track.album_id) ?? '').toLowerCase();
    const audioPath = String(track.audio_path ?? '').toLowerCase();

    return (
      title.includes(term) ||
      artist.includes(term) ||
      album.includes(term) ||
      audioPath.includes(term)
    );
  });
}

// TRACK TABLE

function renderTracks(tracksCollection = state.tracks) {
  const tracks = filterTracks(tracksCollection);

  if (!tracks.length) {
    return `
      <div class="admin-content-pad">
        <p class="admin-empty">No tracks found.</p>
      </div>
    `;
  }

  return `
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead>
          <tr>
            <th>Track</th>
            <th>Artist</th>
            <th>Album</th>
            <th>Duration</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>

        <tbody>
          ${tracks.map(track => `
            <tr>
              <td><strong>${escapeHTML(track.title)}</strong></td>
              <td>${escapeHTML(artistName(track.artist_id))}</td>
              <td>${escapeHTML(albumName(track.album_id))}</td>
              <td>${duration(track.duration_seconds)}</td>
              <td>${statusBadge(track.is_published)}</td>

              <td class="admin-row-actions">
                ${actionButton('tracks', track)}

                <button
                  class="admin-action edit-track-button"
                  data-edit-track="${escapeHTML(track.id)}">
                  Edit
                </button>

                <button
                  class="admin-action delete-track-button"
                  data-delete-track="${escapeHTML(track.id)}"
                  aria-label="Delete ${escapeHTML(track.title)}">
                  Delete
                </button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// ARTIST TABLE

function renderArtists() {
  const artists = filtered(state.artists, ['name', 'bio']);

  if (!artists.length) {
    return `
      <div class="admin-content-pad">
        <p class="admin-empty">No artists found. Add your first artist to start building the catalog.</p>
      </div>
    `;
  }

  return `
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead>
          <tr>
            <th>Profile</th>
            <th>Artist</th>
            <th>Biography</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>

        <tbody>
          ${artists.map(artist => `
            <tr>
              <td>
                ${assetThumbnail(
                  state.assetUrls.artistImages.get(artist.image_path),
                  artist.name,
                  'artist'
                )}
              </td>
              <td><strong>${escapeHTML(artist.name)}</strong></td>
              <td class="admin-short-bio">${escapeHTML(shortText(artist.bio) || '—')}</td>
              <td>${statusBadge(artist.is_published)}</td>
              <td class="admin-row-actions">
                ${actionButton('artists', artist)}
                <button
                  class="admin-action edit-artist-button"
                  data-edit-artist="${escapeHTML(artist.id)}"
                  aria-label="Edit ${escapeHTML(artist.name)}">
                  Edit
                </button>
                <button
                  class="admin-action delete-artist-button"
                  data-delete-artist="${escapeHTML(artist.id)}"
                  aria-label="Delete ${escapeHTML(artist.name)}">
                  Delete
                </button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// ALBUM TABLE

function renderAlbums() {
  const term = state.search.trim().toLowerCase();
  const albums = !term
    ? state.albums
    : state.albums.filter(album =>
      album.title.toLowerCase().includes(term) ||
      artistName(album.artist_id).toLowerCase().includes(term)
    );

  if (!albums.length) {
    return `
      <div class="admin-content-pad">
        <p class="admin-empty">No albums found. Add an album to group your tracks.</p>
      </div>
    `;
  }

  return `
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead>
          <tr>
            <th>Cover</th>
            <th>Album</th>
            <th>Artist</th>
            <th>Release date</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>

        <tbody>
          ${albums.map(album => `
            <tr>
              <td>
                ${assetThumbnail(
                  state.assetUrls.artwork.get(album.cover_path),
                  album.title,
                  'album'
                )}
              </td>
              <td><strong>${escapeHTML(album.title)}</strong></td>
              <td>${escapeHTML(artistName(album.artist_id))}</td>
              <td>${escapeHTML(album.release_date || '—')}</td>
              <td>${statusBadge(album.is_published)}</td>
              <td class="admin-row-actions">
                ${actionButton('albums', album)}
                <button
                  class="admin-action edit-album-button"
                  data-edit-album="${escapeHTML(album.id)}"
                  aria-label="Edit ${escapeHTML(album.title)}">
                  Edit
                </button>
                <button
                  class="admin-action delete-album-button"
                  data-delete-album="${escapeHTML(album.id)}"
                  aria-label="Delete ${escapeHTML(album.title)}">
                  Delete
                </button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// OVERVIEW

function renderOverview() {
  const recent = state.tracks.slice(0, 5);

  return `
    <div class="admin-content-pad">
      <h2>Welcome to CHIKU'S PLAY</h2>
      <p>Your catalog is connected to Supabase.</p>

      <h3>Recently added tracks</h3>

      ${recent.length
        ? renderTracks(recent)
        : '<p class="admin-empty">No tracks available yet.</p>'}
    </div>
  `;
}

// RENDER DASHBOARD

function render() {
  document.querySelectorAll('.admin-tab').forEach(button => {
    button.classList.toggle(
      'active',
      button.dataset.tab === state.tab
    );
  });

  search.hidden = state.tab === 'overview';
  addTrackButton.hidden = state.tab !== 'tracks';
  addArtistButton.hidden = state.tab !== 'artists';
  addAlbumButton.hidden = state.tab !== 'albums';

  const searchLabels = {
    tracks: 'Search tracks…',
    artists: 'Search artists…',
    albums: 'Search albums…'
  };

  search.placeholder = searchLabels[state.tab] || 'Search catalog…';

  if (state.tab === 'overview') {
    view.innerHTML = renderOverview();
  } else if (state.tab === 'tracks') {
    view.innerHTML = renderTracks();
  } else if (state.tab === 'artists') {
    view.innerHTML = renderArtists();
  } else if (state.tab === 'albums') {
    view.innerHTML = renderAlbums();
  }
}

// FORM SELECTORS

function populateSelectors(
  selectedArtist = '',
  selectedAlbum = '',
  selectedGenre = ''
) {
  $('#track-artist').innerHTML =
    '<option value="">Select artist</option>' +
    state.artists.map(artist => `
      <option value="${escapeHTML(artist.id)}">
        ${escapeHTML(artist.name)}
      </option>
    `).join('');

  $('#track-genre').innerHTML =
    '<option value="">Select genre (optional)</option>' +
    state.genres.map(genre => `
      <option value="${escapeHTML(genre.id)}">
        ${escapeHTML(genre.name)}
      </option>
    `).join('');

  $('#track-artist').value = selectedArtist;
  $('#track-genre').value = selectedGenre;

  updateAlbumOptions(selectedArtist, selectedAlbum);
}

function updateAlbumOptions(artistId, selectedAlbum = '') {
  const albums = state.albums.filter(album =>
    !artistId || album.artist_id === artistId
  );

  $('#track-album').innerHTML =
    '<option value="">Single / No album</option>' +
    albums.map(album => `
      <option value="${escapeHTML(album.id)}">
        ${escapeHTML(album.title)}
      </option>
    `).join('');

  $('#track-album').value = selectedAlbum;
}

function populateAlbumArtistSelector(selectedArtist = '') {
  $('#album-artist').innerHTML =
    '<option value="">Select artist</option>' +
    state.artists.map(artist => `
      <option value="${escapeHTML(artist.id)}">
        ${escapeHTML(artist.name)}
      </option>
    `).join('');

  $('#album-artist').value = selectedArtist;
}

function openDialog(dialog, focusSelector) {
  dialog.hidden = false;
  document.body.classList.add('modal-open');

  window.requestAnimationFrame(() => $(focusSelector)?.focus());
}

function closeDialog(dialog) {
  dialog.hidden = true;

  if (trackModal.hidden && artistModal.hidden && albumModal.hidden) {
    document.body.classList.remove('modal-open');
  }
}

function showArtistModal(artist = null) {
  artistForm.reset();
  state.editingArtistId = artist?.id || null;

  $('#artist-id').value = artist?.id || '';
  $('#artist-modal-title').textContent = artist
    ? 'Edit Artist'
    : 'Add New Artist';
  artistSaveButton.textContent = artist ? 'Save Changes' : 'Save Artist';
  $('#artist-name').value = artist?.name || '';
  $('#artist-bio').value = artist?.bio || '';
  $('#artist-published').checked = Boolean(artist?.is_published);
  setDialogMessage('artist-form-message', '');

  openDialog(artistModal, '#artist-name');
}

function closeArtistModal() {
  artistForm.reset();
  state.editingArtistId = null;
  closeDialog(artistModal);
}

function showAlbumModal(album = null) {
  albumForm.reset();
  state.editingAlbumId = album?.id || null;

  $('#album-id').value = album?.id || '';
  $('#album-modal-title').textContent = album
    ? 'Edit Album'
    : 'Add New Album';
  albumSaveButton.textContent = album ? 'Save Changes' : 'Save Album';
  populateAlbumArtistSelector(album?.artist_id || '');
  $('#album-title').value = album?.title || '';
  $('#album-release-date').value = album?.release_date || '';
  $('#album-published').checked = Boolean(album?.is_published);
  setDialogMessage('album-form-message', '');

  openDialog(albumModal, '#album-title');
}

function closeAlbumModal() {
  albumForm.reset();
  state.editingAlbumId = null;
  closeDialog(albumModal);
}

// OPEN AND CLOSE FORM

function showModal(track = null) {
  form.reset();

  state.audioDuration = null;
  state.editingId = track?.id || null;

  $('#track-id').value = track?.id || '';

  $('#track-modal-title').textContent =
    track ? 'Edit Track' : 'Add New Track';

  saveButton.textContent =
    track ? 'Save Changes' : 'Save Track';

  populateSelectors(
    track?.artist_id || '',
    track?.album_id || '',
    track?.genre_id || ''
  );

  $('#track-title').value = track?.title || '';
  $('#track-release-date').value = track?.release_date || '';
  $('#track-published').checked = Boolean(track?.is_published);

  $('#track-audio').required = !track;

  $('#audio-help').textContent = track?.audio_path
    ? 'Choose a new MP3 only if you want to replace the current audio file.'
    : 'MP3 required · Maximum 50 MB';

  $('#audio-duration').textContent = track?.duration_seconds
    ? `Current duration: ${duration(track.duration_seconds)}`
    : 'Audio duration will be detected automatically.';

  $('#track-form-message').textContent = '';

  openDialog(modal, '#track-title');
}

let audioLoadToken = 0;
let pendingAudioCleanup = null;

function cleanupPendingAudioDetection() {
  if (typeof pendingAudioCleanup === 'function') {
    pendingAudioCleanup();
    pendingAudioCleanup = null;
  }
}

function closeModal() {
  cleanupPendingAudioDetection();
  form.reset();

  state.editingId = null;
  state.audioDuration = null;
  closeDialog(modal);
}

// AUDIO FILE VALIDATION AND DURATION

$('#track-audio').addEventListener('change', event => {
  const file = event.target.files?.[0];

  cleanupPendingAudioDetection();
  state.audioDuration = null;

  if (!file) {
    $('#audio-duration').textContent =
      'Audio duration will be detected automatically.';
    return;
  }

  if (!isAudioFile(file)) {
    setFormMessage('Please select a valid MP3 audio file.', true);
    event.target.value = '';
    $('#audio-duration').textContent =
      'Audio duration will be detected automatically.';
    return;
  }

  if (file.size > MAX_AUDIO_SIZE) {
    setFormMessage('MP3 file exceeds the 50 MB limit.', true);
    event.target.value = '';
    $('#audio-duration').textContent =
      'Audio duration will be detected automatically.';
    return;
  }

  const thisToken = ++audioLoadToken;
  $('#audio-duration').textContent = 'Detecting audio duration…';
  setFormMessage('');

  const objectUrl = URL.createObjectURL(file);
  const audio = new Audio();
  audio.preload = 'metadata';

  let cleanedUp = false;
  let timeoutId = null;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (timeoutId) clearTimeout(timeoutId);
    audio.removeEventListener('loadedmetadata', onLoaded);
    audio.removeEventListener('error', onError);
    audio.src = '';
    try {
      URL.revokeObjectURL(objectUrl);
    } catch {}
    if (pendingAudioCleanup === cleanup) {
      pendingAudioCleanup = null;
    }
  };

  pendingAudioCleanup = cleanup;

  const onLoaded = () => {
    if (thisToken !== audioLoadToken || cleanedUp) return;
    cleanup();

    if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
      state.audioDuration = null;
      $('#audio-duration').textContent = 'Could not detect duration.';
      setFormMessage('Could not read audio duration from this file.', true);
      return;
    }

    state.audioDuration = Math.round(audio.duration);

    $('#audio-duration').textContent =
      `Detected duration: ${duration(state.audioDuration)}`;

    setFormMessage('');
  };

  const onError = () => {
    if (thisToken !== audioLoadToken || cleanedUp) return;
    cleanup();
    state.audioDuration = null;

    $('#audio-duration').textContent = 'Could not detect duration.';
    setFormMessage('Could not read this audio file. Please choose a valid MP3 file.', true);
  };

  timeoutId = setTimeout(() => {
    if (thisToken !== audioLoadToken || cleanedUp) return;
    cleanup();
    state.audioDuration = null;

    $('#audio-duration').textContent = 'Duration detection timed out.';
    setFormMessage(
      'Audio duration detection timed out after 4 seconds. Please try selecting the file again.',
      true
    );
  }, 4000);

  audio.addEventListener('loadedmetadata', onLoaded, { once: true });
  audio.addEventListener('error', onError, { once: true });

  audio.src = objectUrl;
  try {
    audio.load();
  } catch {}
});

// COVER IMAGE VALIDATION

$('#track-cover').addEventListener('change', event => {
  const file = event.target.files?.[0];

  if (!file) return;

  const validationError = imageValidationMessage(file);

  if (validationError) {
    setFormMessage(validationError, true);
    event.target.value = '';
    return;
  }

  setFormMessage('');
});

function validateImageSelection(event, messageId) {
  const file = event.target.files?.[0];

  if (!file) return;

  const validationError = imageValidationMessage(file);

  if (validationError) {
    setDialogMessage(messageId, validationError, true);
    event.target.value = '';
    return;
  }

  setDialogMessage(messageId, '');
}

$('#artist-image').addEventListener('change', event => {
  validateImageSelection(event, 'artist-form-message');
});

$('#album-cover').addEventListener('change', event => {
  validateImageSelection(event, 'album-form-message');
});

// UPLOAD FILE TO SUPABASE STORAGE

async function uploadAsset(bucket, file, folder = '') {
  const extension = file.name
    .split('.')
    .pop()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  const prefix = folder ? `${folder.replace(/[^a-z0-9-]/gi, '')}/` : '';
  const path = `${prefix}${crypto.randomUUID()}.${extension || 'bin'}`;

  let contentType = file.type || '';
  if (bucket === 'music' || isAudioFile(file)) {
    contentType = 'audio/mpeg';
  } else if (
    contentType === 'image/jpg' ||
    contentType === 'image/pjpeg' ||
    extension === 'jpg' ||
    extension === 'jpeg'
  ) {
    contentType = 'image/jpeg';
  }

  const { error } = await state.db.storage
    .from(bucket)
    .upload(path, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: contentType || file.type || undefined
    });

  if (error) throw error;

  return path;
}

async function removeFreshUpload(bucket, path) {
  if (!path) return;

  try {
    const { error } = await state.db.storage.from(bucket).remove([path]);

    if (error) {
      console.error(`Could not clean up a new ${bucket} upload:`, error);
    }
  } catch (error) {
    console.error(`Could not clean up a new ${bucket} upload:`, error);
  }
}

async function removeArtistImageIfUnused(path) {
  if (!path) return '';

  try {
    const { count, error } = await state.db
      .from('artists')
      .select('id', { count: 'exact', head: true })
      .eq('image_path', path);

    if (error) {
      return `The previous profile image was kept because its references could not be checked: ${error.message}`;
    }

    if (count) return '';

    const { error: removeError } = await state.db.storage
      .from('artist-images')
      .remove([path]);

    return removeError
      ? `The previous profile image could not be removed: ${removeError.message}`
      : '';
  } catch (error) {
    return `The previous profile image was kept because its references could not be checked: ${error.message}`;
  }
}

async function removeArtworkIfUnused(path) {
  if (!path) return '';

  try {
    const [albumReferences, trackReferences] = await Promise.all([
      state.db
        .from('albums')
        .select('id', { count: 'exact', head: true })
        .eq('cover_path', path),
      state.db
        .from('tracks')
        .select('id', { count: 'exact', head: true })
        .eq('cover_path', path)
    ]);

    if (albumReferences.error || trackReferences.error) {
      const detail = albumReferences.error?.message || trackReferences.error?.message;
      return `The previous artwork was kept because its references could not be checked${detail ? `: ${detail}` : ''}.`;
    }

    if (albumReferences.count || trackReferences.count) return '';

    const { error: removeError } = await state.db.storage
      .from('artwork')
      .remove([path]);

    return removeError
      ? `The previous artwork could not be removed: ${removeError.message}`
      : '';
  } catch (error) {
    return `The previous artwork was kept because its references could not be checked: ${error.message}`;
  }
}

// SAVE NEW OR EDITED TRACK

async function saveTrack(event) {
  event.preventDefault();

  if (saveButton.disabled) return;

  const title = $('#track-title').value.trim();
  const artistId = $('#track-artist').value;
  const albumId = $('#track-album').value || null;
  const genreId = $('#track-genre').value || null;

  const audioFile = $('#track-audio').files?.[0] || null;
  const coverFile = $('#track-cover').files?.[0] || null;

  const releaseDate = $('#track-release-date').value || null;

  if (!title || !artistId) {
    setFormMessage('Enter a title and select an artist.', true);
    return;
  }

  if (!state.artists.some(artist => artist.id === artistId)) {
    setFormMessage('Please select a valid artist.', true);
    return;
  }

  if (!state.editingId && !audioFile) {
    setFormMessage('Please select an MP3 file.', true);
    return;
  }

  if (audioFile && !isAudioFile(audioFile)) {
    setFormMessage('Please select a valid MP3 file.', true);
    return;
  }

  if (audioFile && audioFile.size > MAX_AUDIO_SIZE) {
    setFormMessage('MP3 file exceeds the 50 MB limit.', true);
    return;
  }

  if (audioFile && !state.audioDuration) {
    setFormMessage(
      'Wait for the audio duration to be detected before saving.',
      true
    );
    return;
  }

  if (albumId) {
    const album = state.albums.find(item => item.id === albumId);

    if (!album || album.artist_id !== artistId) {
      setFormMessage(
        'The selected album does not belong to this artist.',
        true
      );
      return;
    }
  }

  if (coverFile) {
    const validationError = imageValidationMessage(coverFile);

    if (validationError) {
      setFormMessage(validationError, true);
      return;
    }
  }

  const wasEditing = Boolean(state.editingId);
  const editingId = state.editingId;

  const existing = state.tracks.find(
    track => track.id === editingId
  );

  saveButton.disabled = true;
  saveButton.textContent = 'Uploading…';

  setFormMessage('Uploading files and saving track…');

  const uploadedPaths = [];
  let databaseSaved = false;

  try {
    let audioPath = existing?.audio_path || null;
    let coverPath = existing?.cover_path || null;

    // Upload new audio only when selected.
    if (audioFile) {
      audioPath = await uploadAsset('music', audioFile);

      uploadedPaths.push({
        bucket: 'music',
        path: audioPath
      });
    }

    // Upload new artwork only when selected.
    if (coverFile) {
      coverPath = await uploadAsset('artwork', coverFile);

      uploadedPaths.push({
        bucket: 'artwork',
        path: coverPath
      });
    }

    const payload = {
      title,
      artist_id: artistId,
      album_id: albumId,
      genre_id: genreId,
      release_date: releaseDate,
      audio_path: audioPath,
      cover_path: coverPath,
      is_published: $('#track-published').checked
    };

    if (audioFile) {
      payload.duration_seconds = state.audioDuration;
    }

    let result;

    if (wasEditing) {
      result = await state.db
        .from('tracks')
        .update(payload)
        .eq('id', editingId)
        .select('id');
    } else {
      payload.duration_seconds = state.audioDuration;

      result = await state.db
        .from('tracks')
        .insert(payload)
        .select('id');
    }

    if (result.error) throw result.error;

    if (!result.data?.length) {
      throw new Error('No track was saved. Check administrator permissions.');
    }

    databaseSaved = true;

  } catch (error) {
    console.error('Track save failed:', error);

    // Clean up newly uploaded files only if the database save failed.
    if (!databaseSaved) {
      for (const asset of uploadedPaths) {
        const { error: cleanupError } = await state.db.storage
          .from(asset.bucket)
          .remove([asset.path]);

        if (cleanupError) {
          console.error(
            'Uploaded file cleanup failed:',
            cleanupError
          );
        }
      }
    }

    setFormMessage(
      error.message || 'Could not save this track.',
      true
    );

    return;

  } finally {
    saveButton.disabled = false;

    saveButton.textContent =
      wasEditing ? 'Save Changes' : 'Save Track';
  }

  // Database save succeeded.
  closeModal();

  try {
    await loadData();
    showSuccess(
      wasEditing
        ? 'Track updated successfully.'
        : 'Track added successfully.'
    );
  } catch (error) {
    console.error('Dashboard refresh failed:', error);

    showError(
      'Track was saved, but the dashboard could not refresh. Reload the page.'
    );
  }
}

async function saveArtist(event) {
  event.preventDefault();

  if (artistSaveButton.disabled) return;

  const name = $('#artist-name').value.trim();
  const bio = $('#artist-bio').value.trim();
  const imageFile = $('#artist-image').files?.[0] || null;
  const wasEditing = Boolean(state.editingArtistId);
  const editingId = state.editingArtistId;
  const existing = state.artists.find(artist => artist.id === editingId);

  if (!name) {
    setDialogMessage('artist-form-message', 'Enter an artist name.', true);
    return;
  }

  if (wasEditing && !existing) {
    setDialogMessage(
      'artist-form-message',
      'This artist is no longer available. Refresh the dashboard and try again.',
      true
    );
    return;
  }

  const validationError = imageValidationMessage(imageFile);

  if (validationError) {
    setDialogMessage('artist-form-message', validationError, true);
    return;
  }

  artistSaveButton.disabled = true;
  artistSaveButton.textContent = 'Saving…';
  setDialogMessage('artist-form-message', 'Saving artist…');

  let uploadedPath = null;
  let imagePath = existing?.image_path || null;
  let databaseSaved = false;

  try {
    if (imageFile) {
      uploadedPath = await uploadAsset('artist-images', imageFile, 'artists');
      imagePath = uploadedPath;
    }

    const payload = {
      name,
      bio,
      image_path: imagePath,
      is_published: $('#artist-published').checked
    };

    const result = wasEditing
      ? await state.db
        .from('artists')
        .update(payload)
        .eq('id', editingId)
        .select('id')
      : await state.db
        .from('artists')
        .insert(payload)
        .select('id');

    if (result.error) throw result.error;

    if (wasEditing && !result.data?.length) {
      throw new Error('No artist was updated. Check administrator permissions.');
    }

    databaseSaved = true;
  } catch (error) {
    if (!databaseSaved) await removeFreshUpload('artist-images', uploadedPath);

    console.error('Artist save failed:', error);
    setDialogMessage(
      'artist-form-message',
      error.message || 'Could not save this artist.',
      true
    );
    return;
  } finally {
    artistSaveButton.disabled = false;
    artistSaveButton.textContent = wasEditing ? 'Save Changes' : 'Save Artist';
  }

  const cleanupWarning = imageFile && existing?.image_path &&
    existing.image_path !== imagePath
    ? await removeArtistImageIfUnused(existing.image_path)
    : '';

  closeArtistModal();

  try {
    await loadData();
    showSuccess(
      `${wasEditing ? 'Artist updated' : 'Artist added'} successfully.` +
      (cleanupWarning ? ` ${cleanupWarning}` : '')
    );
  } catch (error) {
    console.error('Dashboard refresh failed:', error);
    showError(
      `Artist was saved, but the dashboard could not refresh. ${cleanupWarning}`.trim()
    );
  }
}

async function saveAlbum(event) {
  event.preventDefault();

  if (albumSaveButton.disabled) return;

  const title = $('#album-title').value.trim();
  const artistId = $('#album-artist').value;
  const releaseDate = $('#album-release-date').value || null;
  const coverFile = $('#album-cover').files?.[0] || null;
  const wasEditing = Boolean(state.editingAlbumId);
  const editingId = state.editingAlbumId;
  const existing = state.albums.find(album => album.id === editingId);

  if (!title || !artistId) {
    setDialogMessage(
      'album-form-message',
      'Enter an album title and select an artist.',
      true
    );
    return;
  }

  if (!state.artists.some(artist => artist.id === artistId)) {
    setDialogMessage('album-form-message', 'Select a valid artist.', true);
    return;
  }

  if (wasEditing && !existing) {
    setDialogMessage(
      'album-form-message',
      'This album is no longer available. Refresh the dashboard and try again.',
      true
    );
    return;
  }

  const validationError = imageValidationMessage(coverFile);

  if (validationError) {
    setDialogMessage('album-form-message', validationError, true);
    return;
  }

  if (wasEditing && existing.artist_id !== artistId) {
    const { count, error } = await state.db
      .from('tracks')
      .select('id', { count: 'exact', head: true })
      .eq('album_id', editingId);

    if (error) {
      setDialogMessage(
        'album-form-message',
        `Could not verify album tracks: ${error.message}`,
        true
      );
      return;
    }

    if (count) {
      setDialogMessage(
        'album-form-message',
        'This album has tracks. Reassign or update those tracks before changing its artist.',
        true
      );
      return;
    }
  }

  albumSaveButton.disabled = true;
  albumSaveButton.textContent = 'Saving…';
  setDialogMessage('album-form-message', 'Saving album…');

  let uploadedPath = null;
  let coverPath = existing?.cover_path || null;
  let databaseSaved = false;

  try {
    if (coverFile) {
      uploadedPath = await uploadAsset('artwork', coverFile, 'albums');
      coverPath = uploadedPath;
    }

    const payload = {
      title,
      artist_id: artistId,
      cover_path: coverPath,
      release_date: releaseDate,
      is_published: $('#album-published').checked
    };

    const result = wasEditing
      ? await state.db
        .from('albums')
        .update(payload)
        .eq('id', editingId)
        .select('id')
      : await state.db
        .from('albums')
        .insert(payload)
        .select('id');

    if (result.error) throw result.error;

    if (wasEditing && !result.data?.length) {
      throw new Error('No album was updated. Check administrator permissions.');
    }

    databaseSaved = true;
  } catch (error) {
    if (!databaseSaved) await removeFreshUpload('artwork', uploadedPath);

    console.error('Album save failed:', error);
    setDialogMessage(
      'album-form-message',
      error.message || 'Could not save this album.',
      true
    );
    return;
  } finally {
    albumSaveButton.disabled = false;
    albumSaveButton.textContent = wasEditing ? 'Save Changes' : 'Save Album';
  }

  const cleanupWarning = coverFile && existing?.cover_path &&
    existing.cover_path !== coverPath
    ? await removeArtworkIfUnused(existing.cover_path)
    : '';

  closeAlbumModal();

  try {
    await loadData();
    showSuccess(
      `${wasEditing ? 'Album updated' : 'Album added'} successfully.` +
      (cleanupWarning ? ` ${cleanupWarning}` : '')
    );
  } catch (error) {
    console.error('Dashboard refresh failed:', error);
    showError(
      `Album was saved, but the dashboard could not refresh. ${cleanupWarning}`.trim()
    );
  }
}

// TAB BUTTONS

document.querySelectorAll('.admin-tab').forEach(button => {
  button.addEventListener('click', () => {
    state.tab = button.dataset.tab;
    state.search = '';

    search.value = '';

    render();
  });
});

// SEARCH

search.addEventListener('input', () => {
  state.search = search.value;
  render();
});

// ADD TRACK BUTTON

addTrackButton.addEventListener('click', () => {
  showModal();
});

addArtistButton.addEventListener('click', () => {
  showArtistModal();
});

addAlbumButton.addEventListener('click', () => {
  showAlbumModal();
});

// MODAL CONTROLS

$('#close-track-modal').addEventListener('click', closeModal);
$('#cancel-track').addEventListener('click', closeModal);
$('#close-artist-modal').addEventListener('click', closeArtistModal);
$('#cancel-artist').addEventListener('click', closeArtistModal);
$('#close-album-modal').addEventListener('click', closeAlbumModal);
$('#cancel-album').addEventListener('click', closeAlbumModal);

form.addEventListener('submit', saveTrack);
artistForm.addEventListener('submit', saveArtist);
albumForm.addEventListener('submit', saveAlbum);

modal.addEventListener('click', event => {
  if (event.target === modal) closeModal();
});

artistModal.addEventListener('click', event => {
  if (event.target === artistModal) closeArtistModal();
});

albumModal.addEventListener('click', event => {
  if (event.target === albumModal) closeAlbumModal();
});

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;

  if (!modal.hidden) closeModal();
  else if (!artistModal.hidden) closeArtistModal();
  else if (!albumModal.hidden) closeAlbumModal();
});

// ARTIST CHANGE

$('#track-artist').addEventListener('change', event => {
  updateAlbumOptions(event.target.value);
});
async function deleteTrack(trackId, button) {
  if (!trackId) {
    showError('Missing track ID.');
    return;
  }

  const track = state.tracks.find(item => item.id === trackId);

  if (!track) {
    showError('Track not found.');
    return;
  }

  const confirmed = window.confirm(
    `Delete "${track.title}"?\n\nThis cannot be undone.`
  );

  if (!confirmed) return;

  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = 'Deleting…';

  try {
    const { error, count } = await state.db
      .from('tracks')
      .delete({ count: 'exact' })
      .eq('id', trackId);

    if (error) throw error;

    if (!count) {
      throw new Error('No track was deleted. Check administrator permissions.');
    }

    // Database deletion succeeded. Clean up Storage only if no references remain.
    const warnings = [];

    if (track.audio_path) {
      const { count: audioReferences, error: audioReferenceError } =
        await state.db
          .from('tracks')
          .select('id', { count: 'exact', head: true })
          .eq('audio_path', track.audio_path);

      if (audioReferenceError) {
        warnings.push(`Audio reference check failed: ${audioReferenceError.message}`);
      } else if (!audioReferences) {
        const { error: audioDeleteError } = await state.db.storage
          .from('music')
          .remove([track.audio_path]);

        if (audioDeleteError) {
          warnings.push(`Audio file cleanup failed: ${audioDeleteError.message}`);
        }
      }
    }

    if (track.cover_path) {
      const { count: trackCoverReferences, error: trackCoverError } =
        await state.db
          .from('tracks')
          .select('id', { count: 'exact', head: true })
          .eq('cover_path', track.cover_path);

      const { count: albumCoverReferences, error: albumCoverError } =
        await state.db
          .from('albums')
          .select('id', { count: 'exact', head: true })
          .eq('cover_path', track.cover_path);

      if (trackCoverError || albumCoverError) {
        warnings.push('Cover reference check failed.');
      } else if (!trackCoverReferences && !albumCoverReferences) {
        const { error: coverDeleteError } = await state.db.storage
          .from('artwork')
          .remove([track.cover_path]);

        if (coverDeleteError) {
          warnings.push(`Cover file cleanup failed: ${coverDeleteError.message}`);
        }
      }
    }

    await loadData();

    status.hidden = false;
    status.className = warnings.length
      ? 'admin-message error'
      : 'admin-message';
    status.textContent = warnings.length
      ? `Track deleted. ${warnings.join(' ')}`
      : 'Track deleted successfully.';
  } catch (error) {
    console.error('Track deletion failed:', error);

    button.disabled = false;
    button.textContent = originalText;

    showError(`Could not delete track: ${error.message}`);
  }
}



async function deleteArtist(artistId, button) {
  const artist = state.artists.find(item => item.id === artistId);

  if (!artist) {
    showError('Artist not found. Refresh the dashboard and try again.');
    return;
  }

  const originalText = button.textContent;
  button.disabled = true;

  try {
    const [trackReferences, albumReferences] = await Promise.all([
      state.db
        .from('tracks')
        .select('id', { count: 'exact', head: true })
        .eq('artist_id', artistId),
      state.db
        .from('albums')
        .select('id', { count: 'exact', head: true })
        .eq('artist_id', artistId)
    ]);

    if (trackReferences.error || albumReferences.error) {
      const detail = trackReferences.error?.message || albumReferences.error?.message;
      throw new Error(`Could not verify artist references${detail ? `: ${detail}` : ''}`);
    }

    const trackCount = Number(trackReferences.count) || 0;
    const albumCount = Number(albumReferences.count) || 0;

    if (trackCount || albumCount) {
      const dependencies = [
        trackCount && `${trackCount} track${trackCount === 1 ? '' : 's'}`,
        albumCount && `${albumCount} album${albumCount === 1 ? '' : 's'}`
      ].filter(Boolean).join(' and ');

      showError(
        `Cannot delete “${artist.name}” because it still has ${dependencies}. Remove or reassign them first.`
      );
      return;
    }

    const confirmed = window.confirm(
      `Delete “${artist.name}”?\n\nThis cannot be undone.`
    );

    if (!confirmed) return;

    button.textContent = 'Deleting…';

    const { error, count } = await state.db
      .from('artists')
      .delete({ count: 'exact' })
      .eq('id', artistId);

    if (error) throw error;

    if (!count) {
      throw new Error('No artist was deleted. Check administrator permissions.');
    }

    const cleanupWarning = await removeArtistImageIfUnused(artist.image_path);

    await loadData();
    showSuccess(`Artist deleted successfully.${cleanupWarning ? ` ${cleanupWarning}` : ''}`);
  } catch (error) {
    console.error('Artist deletion failed:', error);
    showError(`Could not delete artist: ${error.message}`);
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function deleteAlbum(albumId, button) {
  const album = state.albums.find(item => item.id === albumId);

  if (!album) {
    showError('Album not found. Refresh the dashboard and try again.');
    return;
  }

  const originalText = button.textContent;
  button.disabled = true;

  try {
    const { count: trackCount, error: trackReferenceError } = await state.db
      .from('tracks')
      .select('id', { count: 'exact', head: true })
      .eq('album_id', albumId);

    if (trackReferenceError) {
      throw new Error(`Could not verify album tracks: ${trackReferenceError.message}`);
    }

    if (trackCount) {
      showError(
        `Cannot delete “${album.title}” because ${trackCount} track${trackCount === 1 ? '' : 's'} still reference it. Remove or reassign the tracks first.`
      );
      return;
    }

    const confirmed = window.confirm(
      `Delete “${album.title}”?\n\nThis cannot be undone.`
    );

    if (!confirmed) return;

    button.textContent = 'Deleting…';

    const { error, count } = await state.db
      .from('albums')
      .delete({ count: 'exact' })
      .eq('id', albumId);

    if (error) throw error;

    if (!count) {
      throw new Error('No album was deleted. Check administrator permissions.');
    }

    const cleanupWarning = await removeArtworkIfUnused(album.cover_path);

    await loadData();
    showSuccess(`Album deleted successfully.${cleanupWarning ? ` ${cleanupWarning}` : ''}`);
  } catch (error) {
    console.error('Album deletion failed:', error);
    showError(`Could not delete album: ${error.message}`);
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

// TABLE ACTIONS

view.addEventListener('click', async event => {
  const editButton = event.target.closest('[data-edit-track]');

  if (editButton) {
    const track = state.tracks.find(
      item => item.id === editButton.dataset.editTrack
    );

    if (track) showModal(track);

    return;
  }

  const deleteButton = event.target.closest('[data-delete-track]');

  if (deleteButton) {
    await deleteTrack(deleteButton.dataset.deleteTrack, deleteButton);
    return;
  }

  const editArtistButton = event.target.closest('[data-edit-artist]');

  if (editArtistButton) {
    const artist = state.artists.find(
      item => item.id === editArtistButton.dataset.editArtist
    );

    if (artist) showArtistModal(artist);

    return;
  }

  const deleteArtistButton = event.target.closest('[data-delete-artist]');

  if (deleteArtistButton) {
    await deleteArtist(deleteArtistButton.dataset.deleteArtist, deleteArtistButton);
    return;
  }

  const editAlbumButton = event.target.closest('[data-edit-album]');

  if (editAlbumButton) {
    const album = state.albums.find(
      item => item.id === editAlbumButton.dataset.editAlbum
    );

    if (album) showAlbumModal(album);

    return;
  }

  const deleteAlbumButton = event.target.closest('[data-delete-album]');

  if (deleteAlbumButton) {
    await deleteAlbum(deleteAlbumButton.dataset.deleteAlbum, deleteAlbumButton);
    return;
  }

  const button = event.target.closest('[data-toggle-table]');

  if (!button) return;

  const table = button.dataset.toggleTable;
  const id = button.dataset.toggleId;
  const currentValue = button.dataset.toggleValue === 'true';

  if (!['tracks', 'artists', 'albums'].includes(table)) {
    return;
  }

  button.disabled = true;
  button.textContent = 'Saving…';

  try {
    // Ask PostgREST to return the touched row. Without this, an RLS-denied
    // update can look like a successful no-op to the dashboard.
    const { data, error } = await state.db
      .from(table)
      .update({
        is_published: !currentValue
      })
      .eq('id', id)
      .select('id');

    if (error) throw error;

    if (!data?.length) {
      throw new Error('No record was updated. Check administrator permissions.');
    }

    await loadData();
    const label = table.slice(0, -1);
    showSuccess(
      `${label.charAt(0).toUpperCase()}${label.slice(1)} ${
        currentValue ? 'unpublished' : 'published'
      } successfully.`
    );

  } catch (error) {
    console.error('Publication update failed:', error);

    showError(`Could not update publication status: ${error.message}`);

    button.disabled = false;
    button.textContent = currentValue
      ? 'Unpublish'
      : 'Publish';
  }
});

// SIGN OUT

signoutButton.addEventListener('click', async () => {
  signoutButton.disabled = true;

  try {
    await signOut();

    location.href = 'index.html';

  } catch (error) {
    alert(`Sign out failed: ${error.message}`);

    signoutButton.disabled = false;
  }
});

// ADMIN AUTHENTICATION & CROSS-TAB SYNCHRONIZATION

function revokeBlobUrlsInMap(map) {
  if (!map || !(map instanceof Map)) return;
  for (const url of map.values()) {
    if (typeof url === 'string' && url.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(url);
      } catch {}
    }
  }
  map.clear();
}

function purgeAdminSession() {
  // 1. Reset forms and close modals
  closeModal();
  closeArtistModal();
  closeAlbumModal();

  // 2. Revoke any generated blob URLs and clear asset URL caches
  revokeBlobUrlsInMap(state.assetUrls.artistImages);
  revokeBlobUrlsInMap(state.assetUrls.artwork);

  // 3. Clear sensitive state arrays and identifiers
  state.tracks = [];
  state.artists = [];
  state.albums = [];
  state.genres = [];
  state.editingId = null;
  state.audioDuration = null;
  state.editingArtistId = null;
  state.editingAlbumId = null;
  state.db = null;

  // 4. Clear visible catalog view and reset stats
  view.innerHTML = '';
  $('#stat-tracks').textContent = '0';
  $('#stat-published').textContent = '0';
  $('#stat-artists').textContent = '0';
  $('#stat-albums').textContent = '0';
  $('#admin-user').textContent = 'Signed out';

  // 5. Hide admin content and controls
  content.hidden = true;
  signoutButton.hidden = true;
  status.hidden = true;
}

async function verifyAndLoadAdmin(session, requestToken) {
  try {
    const authorized = await isAdmin();

    // Guard against stale asynchronous resolution if identity changed while awaiting
    if (requestToken !== adminAuthToken) return;

    if (!authorized) {
      purgeAdminSession();
      denied.hidden = false;
      deniedMessage.textContent =
        'Access denied. This account is not an administrator.';
      status.hidden = true;
      signoutButton.hidden = true;
      $('#admin-user').textContent = session?.user?.email || 'Unauthorized';
      return;
    }

    state.db = await getSupabase();
    if (requestToken !== adminAuthToken) return;

    $('#admin-user').textContent =
      session?.user?.email || 'Administrator';

    status.hidden = true;
    denied.hidden = true;
    content.hidden = false;
    signoutButton.hidden = false;

    await loadData(requestToken);
  } catch (error) {
    if (requestToken !== adminAuthToken) return;
    console.error('SOUNDIFY admin authorization error:', error);

    purgeAdminSession();
    denied.hidden = false;
    deniedMessage.textContent =
      error?.message || 'Unable to load admin dashboard.';
    status.hidden = true;
    signoutButton.hidden = true;
  }
}

function handleAdminAuthChange(session) {
  const nextUserId = session?.user?.id || null;
  const isIdentityChange = currentAdminUserId !== nextUserId;

  // Same-user token refresh: do not reset form, close modals, or reload catalog
  if (!isIdentityChange) {
    return;
  }

  // Genuine identity transition: bump generation token synchronously
  const requestToken = ++adminAuthToken;
  currentAdminUserId = nextUserId;

  if (!nextUserId) {
    // User signed out: immediate synchronous purge and transition to signed-out screen
    purgeAdminSession();
    denied.hidden = false;
    deniedMessage.textContent =
      'Sign in required. Please sign in through the public website first.';
    return;
  }

  // New account signed in: immediately conceal previous admin content while verifying
  content.hidden = true;
  signoutButton.hidden = true;
  denied.hidden = true;
  status.hidden = false;
  status.className = 'admin-message';
  status.textContent = 'Verifying administrator authorization…';
  $('#admin-user').textContent = session?.user?.email || 'Checking account…';

  // Defer asynchronous authorization work outside the synchronous callback dispatch
  setTimeout(() => {
    verifyAndLoadAdmin(session, requestToken).catch(err => {
      console.warn('SOUNDIFY admin verification error:', err);
    });
  }, 0);
}

function initializeAdmin() {
  if (authSubscription) return authSubscription;

  authSubscription = onAuthStateChange(session => {
    handleAdminAuthChange(session);
  });

  return authSubscription;
}

// START DASHBOARD

initializeAdmin();
