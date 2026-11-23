import { getSupabase } from './supabase.js';

const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
const maxImageSize = 5 * 1024 * 1024;
const maxAvatarSize = 2 * 1024 * 1024;

export function validateAvatar(file) {
  if (!file) throw new Error('Please select an image file to upload.');
  if (!imageTypes.has(file.type)) {
    throw new Error('Avatar must be a JPG, PNG, WEBP, or AVIF image.');
  }
  if (file.size > maxAvatarSize) {
    throw new Error('Avatar image must not exceed 2 MB.');
  }
}

export async function getAvatarUrl(avatarPath, fallbackUrl = null) {
  if (!avatarPath) return fallbackUrl;
  const db = await getSupabase();
  const { data } = db.storage.from('avatars').getPublicUrl(avatarPath);
  return data?.publicUrl || fallbackUrl;
}

export async function uploadAvatar(file, userId) {
  if (!userId) throw new Error('Authentication is required.');
  validateAvatar(file);
  const db = await getSupabase();

  const extension = file.name.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') || 'webp';
  const path = `${userId}/${crypto.randomUUID()}.${extension}`;

  let uploadTimer;
  const timeoutPromise = new Promise((_, reject) => {
    uploadTimer = setTimeout(() => {
      reject(new Error('Avatar upload timed out after 15 seconds. Please try again with a smaller image or better connection.'));
    }, 15000);
  });

  try {
    const uploadPromise = db.storage
      .from('avatars')
      .upload(path, file, { upsert: false, contentType: file.type, cacheControl: '3600' });
    const { error: uploadError } = await Promise.race([uploadPromise, timeoutPromise]);
    clearTimeout(uploadTimer);
    if (uploadError) throw uploadError;
  } catch (err) {
    clearTimeout(uploadTimer);
    throw err;
  }

  const { data: publicData } = db.storage.from('avatars').getPublicUrl(path);
  return {
    avatarPath: path,
    publicUrl: publicData?.publicUrl || null
  };
}

const rawId = id => String(id || '').replace(/^(song|playlist|artist)-/, '');
const unique = values => [...new Set(values.filter(Boolean))];

async function signedCovers(paths) {
  const result = new Map();
  const values = unique(paths);
  if (!values.length) return result;
  const db = await getSupabase();
  const { data, error } = await db.storage.from('playlist-covers').createSignedUrls(values, 900);
  if (error) throw error;
  for (const item of data || []) if (item.path && item.signedUrl) result.set(item.path, item.signedUrl);
  return result;
}

export async function loadUserLibrary(songs) {
  const db = await getSupabase();
  const [likesResult, playlistsResult, itemsResult, recentResult, followingResult] = await Promise.all([
    db.from('liked_songs').select('track_id').order('created_at', { ascending: false }),
    db.from('playlists').select('id,title,description,cover_path,is_public,created_at').eq('is_system', false).order('created_at', { ascending: false }),
    db.from('playlist_tracks').select('playlist_id,track_id,position').order('playlist_id').order('position'),
    db.from('recently_played').select('track_id,played_at').order('played_at', { ascending: false }).limit(40),
    db.from('followed_artists').select('artist_id,created_at').order('created_at', { ascending: false })
  ]);
  for (const result of [likesResult, playlistsResult, itemsResult, recentResult, followingResult]) if (result.error) throw result.error;
  const covers = await signedCovers((playlistsResult.data || []).map(row => row.cover_path));
  const knownSongs = new Set(songs.map(song => rawId(song.id)));
  const playlists = (playlistsResult.data || []).map(row => ({
    id: `playlist-${row.id}`,
    type: 'playlist',
    personal: true,
    isPublic: Boolean(row.is_public),
    title: row.title,
    description: row.description,
    coverPath: row.cover_path,
    artURL: covers.get(row.cover_path),
    color: '#4d3a54',
    tracks: (itemsResult.data || []).filter(item => item.playlist_id === row.id && knownSongs.has(item.track_id)).map(item => `song-${item.track_id}`)
  }));
  const recent = unique((recentResult.data || []).map(row => knownSongs.has(row.track_id) ? `song-${row.track_id}` : null));
  const following = unique((followingResult.data || []).map(row => `artist-${row.artist_id}`));
  return { likes: unique((likesResult.data || []).map(row => knownSongs.has(row.track_id) ? `song-${row.track_id}` : null)), playlists, recent, following };
}

export async function loadUserPublicPlaylists(userId, songs = []) {
  if (!userId) return [];
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
  const isDemo = params?.get('preview') === '1';
  if (isDemo) {
    if (userId === 'demo-user-id') {
      const demoPlaylists = [
        {
          id: 'playlist-demo-pub-1',
          type: 'playlist',
          personal: false,
          isPublic: true,
          title: 'Neon Sunset Vibes',
          description: 'Late night cruising through the cyber metropolis.',
          art: 'dusk',
          artURL: null,
          color: '#513469',
          tracks: songs.slice(0, 4).map(s => s.id)
        }
      ];
      try {
        const stored = JSON.parse(localStorage.getItem('soundify-demo-playlists') || '[]');
        for (const sp of stored) {
          if (sp.isPublic) {
            demoPlaylists.push({
              ...sp,
              personal: false,
              artURL: null
            });
          }
        }
      } catch {}
      return demoPlaylists;
    }
    if (userId === 'user-alex-1234') {
      return [
        {
          id: 'playlist-alex-pub-1',
          type: 'playlist',
          personal: false,
          isPublic: true,
          title: 'Modular Explorations',
          description: 'Analog synthesis and deep space reverb.',
          art: 'orbit',
          artURL: null,
          color: '#284071',
          tracks: songs.slice(2, 6).map(s => s.id)
        }
      ];
    }
    return [];
  }

  const db = await getSupabase();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    let query = db
      .from('playlists')
      .select('id,title,description,cover_path,created_at')
      .eq('owner_id', userId)
      .eq('is_public', true)
      .order('created_at', { ascending: false });

    if (typeof query.abortSignal === 'function') {
      query = query.abortSignal(controller.signal);
    }

    const { data: playlistsData, error: playlistsError } = await query;
    if (playlistsError) throw playlistsError;

    if (!playlistsData || !playlistsData.length) {
      clearTimeout(timeoutId);
      return [];
    }

    const playlistIds = playlistsData.map(r => r.id);
    let tracksQuery = db
      .from('playlist_tracks')
      .select('playlist_id,track_id,position')
      .in('playlist_id', playlistIds)
      .order('playlist_id')
      .order('position');

    if (typeof tracksQuery.abortSignal === 'function') {
      tracksQuery = tracksQuery.abortSignal(controller.signal);
    }

    const { data: itemsData, error: itemsError } = await tracksQuery;
    clearTimeout(timeoutId);
    if (itemsError) throw itemsError;

    const covers = await signedCovers(playlistsData.map(row => row.cover_path));
    const knownSongs = new Set(songs.map(song => rawId(song.id)));

    return playlistsData.map(row => ({
      id: `playlist-${row.id}`,
      type: 'playlist',
      personal: false,
      isPublic: true,
      title: row.title,
      description: row.description,
      coverPath: row.cover_path,
      artURL: covers.get(row.cover_path) || null,
      color: '#344235',
      tracks: (itemsData || [])
        .filter(item => item.playlist_id === row.id && (knownSongs.has(item.track_id) || !songs.length))
        .map(item => `song-${item.track_id}`)
    }));
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError' || controller.signal.aborted || err.message?.includes('aborted')) {
      throw new Error('Loading public playlists timed out.');
    }
    throw err;
  }
}

export async function setLike(songId, liked, userId) {
  if (!userId) throw new Error('Authentication is required.');
  const db = await getSupabase();
  const trackId = rawId(songId);
  const result = liked
    ? await db.from('liked_songs').insert({ user_id: userId, track_id: trackId })
    : await db.from('liked_songs').delete().eq('user_id', userId).eq('track_id', trackId);
  if (result.error) throw result.error;
}

export async function setFollowArtist(artistId, following, userId) {
  if (!userId) throw new Error('Authentication is required.');
  const db = await getSupabase();
  const cleanArtistId = rawId(artistId);
  if (following) {
    const { error } = await db.from('followed_artists').insert({ user_id: userId, artist_id: cleanArtistId });
    if (error && error.code !== '23505') throw error; // 23505 is PostgreSQL unique_violation
  } else {
    const { error } = await db.from('followed_artists').delete().eq('user_id', userId).eq('artist_id', cleanArtistId);
    if (error) throw error;
  }
}

export async function getArtistFollowerCount(artistId) {
  if (!artistId) return null;
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
  const isDemo = params?.get('preview') === '1';
  if (isDemo) {
    // In preview mode, real follower count is unavailable. Never introduce fake follower counts.
    return null;
  }
  const db = await getSupabase();
  const cleanArtistId = rawId(artistId);
  const { data, error } = await db.rpc('get_artist_follower_count', { p_artist_id: cleanArtistId });
  if (error) throw error;
  return typeof data === 'number' ? data : (data !== null ? Number(data) : 0);
}

export async function recordRecentlyPlayed(songId) {
  const db = await getSupabase();
  const { error } = await db.rpc('record_recently_played', { p_track_id: rawId(songId) });
  if (error) throw error;
}

function validateCover(file) {
  if (!file) return;
  if (!imageTypes.has(file.type) || file.size > maxImageSize) {
    throw new Error('Choose a JPG, PNG, WEBP, or AVIF image no larger than 5 MB.');
  }
}

async function uploadCover(file, userId) {
  validateCover(file);
  if (!file) return null;
  const extension = file.name.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') || 'webp';
  const path = `${userId}/${crypto.randomUUID()}.${extension}`;
  const db = await getSupabase();
  const { error } = await db.storage.from('playlist-covers').upload(path, file, { upsert: false, contentType: file.type, cacheControl: '3600' });
  if (error) throw error;
  return path;
}

export async function savePlaylist({ id, title, description, file, userId, existingCoverPath, isPublic }) {
  const db = await getSupabase();
  let uploadedPath = null;
  try {
    uploadedPath = await uploadCover(file, userId);
    const payload = {
      title,
      description,
      cover_path: uploadedPath || existingCoverPath || null
    };
    if (isPublic !== undefined) {
      payload.is_public = Boolean(isPublic);
    } else if (!id) {
      payload.is_public = false;
    }
    if (!id) payload.owner_id = userId;
    const result = id
      ? await db.from('playlists').update(payload).eq('id', rawId(id)).select('id').single()
      : await db.from('playlists').insert(payload).select('id').single();
    if (result.error) throw result.error;
    if (!result.data?.id) throw new Error('Playlist could not be saved.');
    return result.data.id;
  } catch (error) {
    if (uploadedPath) await db.storage.from('playlist-covers').remove([uploadedPath]);
    throw error;
  }
}

export async function deletePlaylist(playlistId, coverPath) {
  const db = await getSupabase();
  const { error } = await db.from('playlists').delete().eq('id', rawId(playlistId));
  if (error) throw error;
  if (coverPath) await db.storage.from('playlist-covers').remove([coverPath]);
}

export async function addTracks(playlistId, songIds, existingCount) {
  const db = await getSupabase();
  const rows = unique(songIds).map((id, index) => ({ playlist_id: rawId(playlistId), track_id: rawId(id), position: existingCount + index }));
  if (!rows.length) return;
  const { error } = await db.from('playlist_tracks').upsert(rows, { onConflict: 'playlist_id,track_id', ignoreDuplicates: true });
  if (error) throw error;
}

export async function removeTrack(playlistId, songId) {
  const db = await getSupabase();
  const { error } = await db.from('playlist_tracks').delete().eq('playlist_id', rawId(playlistId)).eq('track_id', rawId(songId));
  if (error) throw error;
}
