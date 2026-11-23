// ====================================================================
// SOUNDIFY Phase 5 Stage 3: Music Discovery & Personalized Recommendation Engine
// Module: js/discovery-service.js
// Description: Client-side personalized recommendation algorithms,
//              new release sorting, album recommendations, and genre grouping.
// ====================================================================

const ONE_DAY_MS = 86_400_000;

/**
 * Computes personalized track recommendations for the authenticated user
 * based on likes, follows, recents, and preferred genres.
 * Strictly executes client-side using authorized in-memory library data.
 */
export function computePersonalizedRecommendations(catalogSongs = [], library = {}, limit = 10) {
  if (!catalogSongs.length) return [];

  // 1. Single O(1) Map for song lookups
  const songMap = new Map(catalogSongs.map(s => [s.id, s]));

  const likedSet = new Set(library.likes || []);
  const followingSet = new Set(library.following || []);
  const recent10Set = new Set((library.recent || []).slice(0, 10));

  // 2. Profile user preferences from likes and recents
  const userGenreWeights = new Map();
  const likedArtistSet = new Set();
  const likedAlbumSet = new Set();

  for (const songId of likedSet) {
    const s = songMap.get(songId);
    if (!s) continue;
    if (s.genre) userGenreWeights.set(s.genre, (userGenreWeights.get(s.genre) || 0) + 3);
    if (s.artistId) likedArtistSet.add(s.artistId);
    if (s.albumId) likedAlbumSet.add(s.albumId);
  }

  for (const songId of (library.recent || []).slice(0, 25)) {
    const s = songMap.get(songId);
    if (!s) continue;
    if (s.genre) userGenreWeights.set(s.genre, (userGenreWeights.get(s.genre) || 0) + 1);
  }

  // If user has zero likes, follows, and recents (cold start), return empty array
  // so caller can display neutral discovery content without inventing scores.
  if (!likedSet.size && !followingSet.size && !(library.recent || []).length) {
    return [];
  }

  const now = Date.now();

  // 3. Score candidate tracks
  const scored = [];
  for (const track of catalogSongs) {
    // Exclusion rules: never recommend what the user has already liked
    if (likedSet.has(track.id)) continue;
    // Suppress immediate recent repeats
    if (recent10Set.has(track.id)) continue;

    let score = 0;

    // Signal A: Followed artist (+40)
    if (track.artistId && followingSet.has(track.artistId)) {
      score += 40;
    }

    // Signal B: Artist of liked song (+25)
    if (track.artistId && likedArtistSet.has(track.artistId)) {
      score += 25;
    }

    // Signal C: Album of liked song (+15)
    if (track.albumId && likedAlbumSet.has(track.albumId)) {
      score += 15;
    }

    // Signal D: Preferred genre affinity (up to +30, scaled by listening frequency)
    if (track.genre && userGenreWeights.has(track.genre)) {
      const gWeight = userGenreWeights.get(track.genre);
      score += Math.min(30, gWeight * 4);
    }

    // Signal E: Bounded freshness score (0 to 5 points based on real releaseDate)
    if (track.releaseDate) {
      const releaseTime = new Date(track.releaseDate).getTime();
      if (!Number.isNaN(releaseTime) && releaseTime <= now) {
        const daysOld = Math.floor((now - releaseTime) / ONE_DAY_MS);
        if (daysOld <= 180) {
          // Releases <= 36 days: +5; 37-72 days: +4; ... > 180 days: 0
          score += Math.max(0, Math.min(5, Math.floor((180 - daysOld) / 36) + 1));
        }
      }
    }
    // Missing releaseDate receives strictly 0 freshness points.

    if (score > 0) {
      scored.push({ track, score });
    }
  }

  // 4. Stable sort by score descending, then title ascending
  scored.sort((a, b) => b.score - a.score || a.track.title.localeCompare(b.track.title));
  return scored.slice(0, limit).map(x => x.track);
}

/**
 * Recommends albums based on followed artists, liked tracks/artists, and preferred genres.
 */
export function getRecommendedAlbums(catalogAlbums = [], catalogSongs = [], library = {}, limit = 6) {
  if (!catalogAlbums.length) return [];

  const songMap = new Map(catalogSongs.map(s => [s.id, s]));
  const likedSet = new Set(library.likes || []);
  const followingSet = new Set(library.following || []);

  const likedArtistSet = new Set();
  const userGenreWeights = new Map();
  for (const songId of likedSet) {
    const s = songMap.get(songId);
    if (!s) continue;
    if (s.artistId) likedArtistSet.add(s.artistId);
    if (s.genre) userGenreWeights.set(s.genre, (userGenreWeights.get(s.genre) || 0) + 1);
  }

  const scored = [];
  for (const album of catalogAlbums) {
    // Check if user already liked all tracks in this album
    const albumTrackIds = album.tracks || [];
    if (albumTrackIds.length && albumTrackIds.every(id => likedSet.has(id))) {
      continue;
    }

    let score = 0;
    if (album.artistId && followingSet.has(album.artistId)) score += 40;
    if (album.artistId && likedArtistSet.has(album.artistId)) score += 25;

    // Check genre of album tracks
    for (const tid of albumTrackIds) {
      const tr = songMap.get(tid);
      if (tr?.genre && userGenreWeights.has(tr.genre)) {
        score += Math.min(20, (userGenreWeights.get(tr.genre) || 0) * 3);
        break;
      }
    }

    // Bounded freshness score
    if (album.releaseDate) {
      const releaseTime = new Date(album.releaseDate).getTime();
      if (!Number.isNaN(releaseTime) && releaseTime <= Date.now()) {
        const daysOld = Math.floor((Date.now() - releaseTime) / ONE_DAY_MS);
        if (daysOld <= 180) score += Math.max(0, Math.min(5, Math.floor((180 - daysOld) / 36) + 1));
      }
    }

    scored.push({ album, score });
  }

  scored.sort((a, b) => b.score - a.score || a.album.title.localeCompare(b.album.title));
  return scored.slice(0, limit).map(x => x.album);
}

/**
 * Returns new releases (albums and standalone singles) sorted by releaseDate DESC.
 * Prevents album tracks from being duplicated as standalone releases.
 */
export function getNewReleases(catalog = {}, limit = 8) {
  const albums = catalog.albums || [];
  const songs = catalog.songs || [];

  // Standalone singles: songs that do NOT belong to an album (albumId is null or album title is Single)
  const singles = songs.filter(s => !s.albumId || s.album?.toLowerCase() === 'single');

  const releases = [
    ...albums.map(a => ({ ...a, releaseType: 'album' })),
    ...singles.map(s => ({ ...s, releaseType: 'single' }))
  ];

  const toTime = (dateStr, createdStr) => {
    if (dateStr) {
      const t = new Date(dateStr).getTime();
      if (!Number.isNaN(t)) return t;
    }
    if (createdStr) {
      const t = new Date(createdStr).getTime();
      if (!Number.isNaN(t)) return t;
    }
    return 0;
  };

  releases.sort((a, b) => {
    const timeA = toTime(a.releaseDate, a.createdAt);
    const timeB = toTime(b.releaseDate, b.createdAt);
    return timeB - timeA || a.title.localeCompare(b.title);
  });

  return releases.slice(0, limit);
}

/**
 * Groups published catalog items by genre.
 */
export function getGenreBreakdown(catalog = {}) {
  const songs = catalog.songs || [];
  const albums = catalog.albums || [];
  const rawGenres = catalog.genres || [];
  const genreMap = new Map();

  // Initialize from catalog.genres if available
  for (const g of rawGenres) {
    if (g?.name) {
      genreMap.set(g.name, { name: g.name, songCount: 0, albumCount: 0, color: '#355040' });
    }
  }

  for (const s of songs) {
    if (!s.genre) continue;
    const g = genreMap.get(s.genre) || { name: s.genre, songCount: 0, albumCount: 0, color: s.color || '#355040' };
    g.songCount++;
    genreMap.set(s.genre, g);
  }

  const songMap = new Map(songs.map(s => [s.id, s]));
  for (const a of albums) {
    const firstSong = (a.tracks || []).map(id => songMap.get(id)).find(Boolean);
    const genre = firstSong?.genre;
    if (genre && genreMap.has(genre)) {
      genreMap.get(genre).albumCount++;
    }
  }

  // Avoid showing misleading genre cards with zero published tracks
  const activeGenres = [...genreMap.values()].filter(g => g.songCount > 0);
  return activeGenres.sort((a, b) => b.songCount - a.songCount || a.name.localeCompare(b.name));
}
