import {getSupabase} from './supabase.js';

async function list(table,columns,order,filters={},secondary='id'){
 const db=await getSupabase(), result=[];
 // Supabase's default API row limit is 1,000. Page explicitly and use a stable order.
 const size=200;
 for(let start=0;;start+=size){
  let query=db.from(table).select(columns).order(order);
  if(secondary&&secondary!==order)query=query.order(secondary);
  for(const [field,value] of Object.entries(filters))query=query.eq(field,value);
  const {data,error}=await query.range(start,start+size-1);
  if(error){const err=new Error(`Could not read ${table}: ${error.message}`);err.code=error.code;err.details=error.details;err.hint=error.hint;err.status=error.status;throw err;}
  const rows=data||[];
  result.push(...rows);
  if(rows.length<size)return result;
 }
}
export const getPublishedTracks=()=>list('tracks','id,title,artist_id,album_id,genre_id,duration_seconds,audio_path,cover_path,release_date,created_at','title',{is_published:true});
export const getArtists=()=>list('artists','id,name,bio,image_path','name',{is_published:true});
export const getAlbums=()=>list('albums','id,title,artist_id,cover_path,release_date,created_at','title',{is_published:true});
export const getGenres=()=>list('genres','id,name,slug','name');
export const getPublicPlaylists=()=>list('playlists','id,title,description,cover_path,is_featured,is_system','title',{is_public:true});
export const getHomepageSettings=()=>list('site_settings','setting_key,setting_value','setting_key',{},null);

async function sign(bucket,paths){
 const unique=[...new Set(paths.filter(Boolean))], map=new Map();
 if(!unique.length)return map;
 const db=await getSupabase();
 for(let i=0;i<unique.length;i+=100){
  try{
   const {data}=await db.storage.from(bucket).createSignedUrls(unique.slice(i,i+100),900);
   for(const row of data||[]) if(row.signedUrl)map.set(row.path,row.signedUrl);
  }catch{/* Missing or unavailable artwork uses the existing fallback tile. */}
 }
 return map;
}

const keys=(type,id)=>`${type}-${id}`;

export async function loadCatalog(){
 const [tracks,artists,albums,genres,playlists,settings,items]=await Promise.all([
  getPublishedTracks(),getArtists(),getAlbums(),getGenres(),getPublicPlaylists(),getHomepageSettings(),
  list('playlist_tracks','playlist_id,track_id,position','playlist_id',{},'position')
 ]);
 const [artwork,portraits,covers]=await Promise.all([
  sign('artwork',[...tracks,...albums].map(x=>x.cover_path)),sign('artist-images',artists.map(x=>x.image_path)),
  sign('playlist-covers',playlists.filter(x=>x.is_system).map(x=>x.cover_path))
 ]);
 const artistNames=new Map(artists.map(x=>[x.id,x.name]));
 const genreNames=new Map(genres.map(x=>[x.id,x.name]));
 const albumRows=new Map(albums.map(x=>[x.id,x]));
 const songs=tracks.map(t=>({
  id:keys('song',t.id),
  type:'song',
  title:t.title,
  artist:artistNames.get(t.artist_id)||'Unknown artist',
  artistId:keys('artist',t.artist_id),
  album:albumRows.get(t.album_id)?.title||'Single',
  albumId:t.album_id?keys('album',t.album_id):null,
  genre:genreNames.get(t.genre_id),
  duration:t.duration_seconds,
  releaseDate:t.release_date||null,
  createdAt:t.created_at||null,
  audioPath:t.audio_path,
  artURL:artwork.get(t.cover_path)||artwork.get(albumRows.get(t.album_id)?.cover_path),
  color:'#355040'
 }));
 const songIds=new Set(songs.map(x=>x.id));
 const grouping=(rows,field,value)=>rows.filter(x=>x[field]===value).map(x=>keys('song',x.track_id||x.id)).filter(id=>songIds.has(id));
 return {
  genres,
  songs,
  artists:artists.map(a=>({id:keys('artist',a.id),type:'artist',title:a.name,artist:a.name,description:a.bio,artURL:portraits.get(a.image_path),color:'#3a435c',tracks:grouping(tracks,'artist_id',a.id)})),
  albums:albums.map(a=>({id:keys('album',a.id),type:'album',title:a.title,artist:artistNames.get(a.artist_id),artistId:keys('artist',a.artist_id),artURL:artwork.get(a.cover_path),releaseDate:a.release_date||null,createdAt:a.created_at||null,color:'#47543a',tracks:grouping(tracks,'album_id',a.id)})),
  playlists:playlists.map(x=>({id:keys('playlist',x.id),type:'playlist',title:x.title,description:x.description,featured:x.is_featured,artURL:x.is_system?covers.get(x.cover_path):undefined,color:'#4d3a54',tracks:grouping(items,'playlist_id',x.id)})),
  settings:Object.fromEntries(settings.filter(x=>typeof x.setting_value==='string').map(x=>[x.setting_key,x.setting_value]))
 };
}

// --------------------------------------------------------------------
// Discovery RPC Caches (15-Minute TTL)
// --------------------------------------------------------------------
const CACHE_TTL_MS = 15 * 60 * 1000;
let trendingCache = null;
let popularArtistsCache = null;

export async function getTrendingTrackIds(limit = 10) {
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
  if (params?.get('preview') === '1') return [];
  const now = Date.now();
  if (trendingCache && (now - trendingCache.timestamp) < CACHE_TTL_MS) {
    return trendingCache.data.slice(0, limit);
  }
  try {
    const db = await getSupabase();
    const clampedLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);
    const { data, error } = await db.rpc('get_trending_tracks', { p_limit: clampedLimit });
    if (error) throw error;
    const ids = (data || []).map(r => `song-${r.track_id}`);
    trendingCache = { data: ids, timestamp: now };
    return ids.slice(0, limit);
  } catch (err) {
    console.warn('Could not fetch trending tracks:', err);
    return [];
  }
}

export async function getPopularArtistIds(limit = 10) {
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
  if (params?.get('preview') === '1') return [];
  const now = Date.now();
  if (popularArtistsCache && (now - popularArtistsCache.timestamp) < CACHE_TTL_MS) {
    return popularArtistsCache.data.slice(0, limit);
  }
  try {
    const db = await getSupabase();
    const clampedLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);
    const { data, error } = await db.rpc('get_popular_artists', { p_limit: clampedLimit });
    if (error) throw error;
    const ids = (data || []).map(r => `artist-${r.artist_id}`);
    popularArtistsCache = { data: ids, timestamp: now };
    return ids.slice(0, limit);
  } catch (err) {
    console.warn('Could not fetch popular artists:', err);
    return [];
  }
}

export function invalidateDiscoveryCache() {
  trendingCache = null;
  popularArtistsCache = null;
}
