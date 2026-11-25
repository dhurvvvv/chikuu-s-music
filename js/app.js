import {configured,getSupabase} from './supabase.js';
import {loadCatalog,getTrendingTrackIds,getPopularArtistIds,invalidateDiscoveryCache} from './catalog-service.js';
import {computePersonalizedRecommendations,getRecommendedAlbums,getNewReleases,getGenreBreakdown} from './discovery-service.js';
import {getSession,onAuthStateChange,signOut,getProfile,isAdmin,displayNameFor,updateProfile,checkUsernameAvailability,getPublicProfile} from './auth.js';
import {loadUserLibrary,setLike,setFollowArtist,getArtistFollowerCount,recordRecentlyPlayed,savePlaylist,deletePlaylist,addTracks,removeTrack,validateAvatar,uploadAvatar,getAvatarUrl,loadUserPublicPlaylists} from './library-service.js';
import {icon} from './icons.js';
import {navigation} from './navigation.js';
import {createPlayer} from './player.js';

const $=s=>document.querySelector(s), safe=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const params=new URLSearchParams(location.search),demo=params.get('preview')==='1'||(!configured&&params.get('preview')!=='0');
const read=(k,f)=>{try{const v=JSON.parse(localStorage.getItem(`soundify-${demo?'demo':location.host}-${k}`));return Array.isArray(v)?v:f;}catch{return f;}};
const save=(k,v)=>{try{localStorage.setItem(`soundify-${demo?'demo':location.host}-${k}`,JSON.stringify(v));}catch{}};
const SEARCH_HISTORY_KEY='soundify-search-history';
const getSearchHistory=()=>{try{const v=JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY));return Array.isArray(v)?v.filter(x=>typeof x==='string'&&x.trim()):[];}catch{return [];}};
const saveSearchHistory=h=>{try{localStorage.setItem(SEARCH_HISTORY_KEY,JSON.stringify(h.slice(0,10)));}catch{}};
const addSearchHistory=q=>{const clean=String(q||'').trim();if(!clean||clean.length<2)return;const next=[clean,...getSearchHistory().filter(x=>x.toLowerCase()!==clean.toLowerCase())].slice(0,10);saveSearchHistory(next);};
const clearSearchHistory=()=>{try{localStorage.removeItem(SEARCH_HISTORY_KEY);}catch{}};

// === MANDATORY AUTHENTICATION VERIFICATION GATE ===
const hash=location.hash||'';
const urlSearch=location.search||'';
const isOAuthCallback=hash.includes('access_token=')||urlSearch.includes('code=');
const isOAuthError=hash.includes('error=')||urlSearch.includes('error=');

if(isOAuthError){
  const target='login.html'+(hash?hash:urlSearch);
  if(typeof location.replace==='function')location.replace(target);
  else location.href=target;
  throw new Error('OAuth error redirected to login.');
}

let verifiedSession=null;
try{
  verifiedSession=await getSession();
}catch(e){
  console.warn('Initial session check error:',e);
}

if(demo&&!verifiedSession?.user){
  verifiedSession={
    user:{
      id:'demo-user-preview',
      email:'preview@chikusplay.test',
      user_metadata:{full_name:"Chiku's Listener",username:'chiku_preview'}
    }
  };
}

if(!verifiedSession?.user&&isOAuthCallback){
  try{
    const db=await getSupabase();
    verifiedSession=await new Promise(resolve=>{
      const {data:authListener}=db.auth.onAuthStateChange((_event,authSession)=>{
        if(authSession?.user){
          try{authListener.subscription.unsubscribe();}catch{}
          resolve(authSession);
        }
      });
      setTimeout(()=>{
        try{authListener.subscription.unsubscribe();}catch{}
        resolve(null);
      },4000);
    });
  }catch(oauthErr){
    console.warn('OAuth session resolution error:',oauthErr);
  }
}

if(!verifiedSession?.user){
  if(typeof location.replace==='function')location.replace('login.html');
  else location.href='login.html';
  throw new Error('Authentication required. Redirecting to login.');
}

if(isOAuthCallback){
  try{history.replaceState(null,'',location.pathname);}catch{}
}

document.documentElement.classList.remove('auth-pending');

let connection='ready',detail='',data={songs:[],albums:[],artists:[],playlists:[],settings:{}};
try{if(demo)data={...data,...await import('./mock-data.js')};else if(!configured)connection='setup';else data=await loadCatalog();}catch(e){connection='error';detail=e?.message||String(e);console.error(e);}
const {songs,albums,artists,playlists,settings}=data,featured=demo?[...playlists].reverse():playlists.filter(x=>x.featured),brand=(!settings.brand_name||settings.brand_name.trim().toUpperCase()==='SOUNDIFY')?"CHIKU'S PLAY":settings.brand_name.trim().slice(0,40);
let session=null,currentAuthUserId=null,libraryLoadToken=0,library={likes:demo?read('likes',[]):[],playlists:demo?read('playlists',[]):[],recent:demo?read('recent',[]):[],following:demo?read('following',[]):[]},page='home',query='',searchType='All',libraryType='All',homeCategory='All',toastTimer;
let currentTheme=localStorage.getItem('soundify-pref-theme')||'dark',currentAccent=localStorage.getItem('soundify-pref-accent')||'green',fsArtMode=localStorage.getItem('soundify-fs-art-mode')||'cover';
function applyTheme(theme){currentTheme=theme||currentTheme||'dark';localStorage.setItem('soundify-pref-theme',currentTheme);if(currentTheme==='system'){const isDark=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.setAttribute('data-theme',isDark?'dark':'light');}else{document.documentElement.setAttribute('data-theme',currentTheme);}}
function applyAccent(accent){currentAccent=accent||currentAccent||'green';localStorage.setItem('soundify-pref-accent',currentAccent);document.documentElement.setAttribute('data-accent',currentAccent);}
function applyFsArtMode(mode){fsArtMode=mode||fsArtMode||'cover';localStorage.setItem('soundify-fs-art-mode',fsArtMode);const wrap=$('#fullscreen-art-wrap');if(wrap)wrap.classList.toggle('mode-cover',fsArtMode==='cover');const btn=$('#fullscreen-player .fullscreen-art-mode-btn');if(btn){btn.setAttribute('aria-label',fsArtMode==='cover'?'Switch to vinyl disc mode':'Switch to album cover mode');btn.title=fsArtMode==='cover'?'Switch to vinyl disc mode':'Switch to album cover mode';}}
applyTheme(currentTheme);applyAccent(currentAccent);
if(window.matchMedia){window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change',e=>{if((localStorage.getItem('soundify-pref-theme')||'dark')==='system'){document.documentElement.setAttribute('data-theme',e.matches?'dark':'light');}});}
session=verifiedSession;currentAuthUserId=verifiedSession?.user?.id||null;
let currentProfile=null,avatarFileToUpload=null,avatarPreviewBlobUrl=null,usernameCheckTimer=null,isUsernameAvailable=true,isSubmittingProfile=false;
const publicPlaylistsCache=new Map();
const followerCountsCache=new Map();
const followLocks=new Set();
const allPlaylists=()=>[...playlists,...library.playlists,...publicPlaylistsCache.values()], catalog=()=>[...songs,...albums,...artists,...allPlaylists()], find=id=>catalog().find(x=>x.id===id),fmt=s=>`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
const art=x=>{const src=x?.artURL||(x?.art?`assets/images/${x.art}.jpg`:'');return `<div class="art" style="--art-color:${x?.color||'#344235'}" aria-hidden="true">${icon('library')}${src?`<img src="${safe(src)}" alt="" loading="lazy">`:''}</div>`;};
const b=(act,i,label,attrs='')=>`<button type="button" class="icon-btn" data-act="${act}" aria-label="${label}" title="${label}" ${attrs}>${icon(i)}</button>`;
const link=(dest,i,label)=>`<a class="nav-link" href="#${dest}" data-nav="${dest}">${icon(i)}<span>${label}</span></a>`;
const empty=(h,p)=>`<div class="empty">${icon('library')}<h2>${h}</h2><p>${p}</p></div>`;
const heading=(h,e='YOUR SOUND, YOUR SPACE')=>`<div class="page-title"><p class="eyebrow">${e}</p><h1>${h}</h1></div>`;
const liked=()=>library.likes.map(find).filter(Boolean), recent=()=>library.recent.map(find).filter(Boolean), followed=()=>(library.following||[]).map(find).filter(Boolean);
const formatFollowers=n=>n===null||n===undefined?'<span class="follower-count-unavailable" title="Follower counts are unavailable in preview mode">— followers</span>':`<span class="follower-count-val">${Number(n)||0}</span> ${(Number(n)||0)===1?'follower':'followers'}`;
function toast(s){const el=$('#toast');if(!el)return;el.textContent='';setTimeout(()=>{if(el)el.textContent=s;},20);clearTimeout(toastTimer);toastTimer=setTimeout(()=>{if(el)el.textContent='';},3400);}
function account(){if(demo||session?.user)return true;toast('Sign in to save music to your library.');return false;}
function sidebar(){
  $('#sidebar').innerHTML=`
    <div class="sidebar-panel sidebar-nav-panel">
      <a class="brand" href="#home" data-nav="home">
        <img src="assets/icons/logo.svg" alt="">
        ${safe(brand)}<span>.</span>
      </a>
      <nav class="sidebar-nav">
        ${link('home','home','Home')}
        ${link('search','search','Search')}
        ${link('discover','library','Discover')}
      </nav>
    </div>
    <div class="sidebar-panel sidebar-library-panel">
      <div class="library-panel-head">
        <a class="nav-link library-nav-btn" href="#library" data-nav="library">
          ${icon('library')}
          <span>Your Library</span>
        </a>
        <button type="button" class="icon-btn create-playlist-btn" data-act="create-playlist" aria-label="Create playlist" title="Create playlist">
          ${icon('plus')}
        </button>
      </div>
      <div class="sidebar-filters">
        <a class="nav-filter-pill" href="#library" data-nav="library">All</a>
        <a class="nav-filter-pill" href="#liked" data-nav="liked">Liked</a>
        <a class="nav-filter-pill" href="#recent" data-nav="recent">Recent</a>
      </div>
      <div class="playlists-scroll">
        <div class="playlists">
          ${library.playlists.length?library.playlists.map(p=>`
            <a href="#${p.id}" data-nav="${p.id}" class="playlist-row">
              ${art(p)}
              <div class="playlist-row-info">
                <span class="playlist-row-title">${safe(p.title)}</span>
                <small class="playlist-row-sub">Playlist · ${p.personal?'You':"CHIKU'S PLAY"}</small>
              </div>
            </a>
          `).join(''):'<p class="side-empty">Your playlists will appear here.</p>'}
        </div>
      </div>
      <div class="side-foot"><span></span> ${demo?'DEMO CATALOG':'YOUR LIBRARY'}</div>
    </div>
  `;
}
async function refreshLibrary(rerender=true){
  if(demo){if(rerender){sidebar();render(page);}return;}
  const requestUserId=session?.user?.id;
  if(!requestUserId)return;
  const requestToken=++libraryLoadToken;
  try{
    const loadedData=await loadUserLibrary(songs);
    if(requestToken!==libraryLoadToken||session?.user?.id!==requestUserId)return;
    library=loadedData;
    sidebar();
    if(rerender)render(page);
  }catch(e){
    if(requestToken===libraryLoadToken&&session?.user?.id===requestUserId){
      console.warn('Could not load your library:',e);
      toast(`Could not load your library: ${e.message}`);
    }
  }
}
async function accountUI(){
  try{
    if(!session?.user){
      session=await getSession();
    }
  }catch{
    session=null;
  }
  if(!session?.user && demo){
    session={
      user:{
        id:'demo-user-id',
        email:'listener@soundify.test',
        user_metadata:{full_name:'Soundify Listener'}
      }
    };
    if(!currentProfile){
      currentProfile={
        id:'demo-user-id',
        display_name:'Soundify Listener',
        username:'soundify_listener',
        bio:"Electronic music enthusiast & CHIKU'S PLAY explorer."
      };
    }
  }
  currentAuthUserId=session?.user?.id||null;
  const d=$('#profile');
  if(!d)return;
  if(!session?.user){
    currentProfile=null;
    if(typeof location.replace==='function')location.replace('login.html');
    else location.href='login.html';
    return;
  }
  let admin=false;
  if(!demo && session?.user){
    try{
      const [p,a]=await Promise.all([getProfile(session.user.id),isAdmin()]);
      currentProfile=p;
      admin=a;
    }catch(e){console.warn('Profile fetch error:', e);}
  }
  const n=safe(displayNameFor(session.user,currentProfile));
  let avatarSrc=null;
  try{
    avatarSrc=await getAvatarUrl(currentProfile?.avatar_path, currentProfile?.avatar_url || session.user.user_metadata?.avatar_url);
  }catch{
    avatarSrc=currentProfile?.avatar_url || session.user.user_metadata?.avatar_url || null;
  }
  const avatarHtml=avatarSrc?`<img src="${safe(avatarSrc)}" alt="">`:safe((n[0]||'A').toUpperCase());
  const handle=currentProfile?.username?`<small class="profile-handle">@${safe(currentProfile.username)}</small>`:'';
  const profileNav=currentProfile?.username?`profile/@${currentProfile.username}`:`profile/${session.user.id}`;
  d.outerHTML=`<details id="profile"><summary aria-label="Account menu"><span class="avatar">${avatarHtml}</span><span class="guest-label">${n}</span>${icon('down')}</summary><div class="profile-menu"><strong>${n}</strong>${handle}<small class="profile-email-badge">${safe(session.user.email||'')}</small><a href="#${profileNav}" data-nav="${profileNav}" class="menu-action">${icon('user')} Your Profile</a><a href="#settings" data-nav="settings" class="menu-action">${icon('queue')} Settings</a><button type="button" class="menu-action" data-act="open-edit-profile">${icon('plus')} Edit Profile</button>${admin?'<a href="admin.html" class="menu-action">Admin tools</a>':''}<button data-act="sign-out" class="secondary">Sign out</button></div></details>`;
  await refreshLibrary();
}
function card(x){const sub=x.type==='artist'?'Artist':x.type==='album'?`Album${x.artist?` · ${safe(x.artist)}`:''}`:x.type==='playlist'?'Playlist':`Song${x.artist?` · ${safe(x.artist)}`:''}`;return `<button class="card ${x.type}${x.type==='artist'&&library.following?.includes(x.id)?' is-following':''}" ${x.type==='song'?`data-play="${x.id}"`:`data-nav="${x.id}"`}>${art(x)}<span class="card-play">${icon(x.type==='song'?'play':'arrow')}</span><strong>${safe(x.title)}</strong><small>${sub}</small></button>`;}
function grid(xs,msg='Published items will appear here when available.'){return xs.length?`<div class="cards">${xs.map(card).join('')}</div>`:empty('Nothing here yet',msg);}
function section(t,xs,target){return `<section class="shelf"><div class="section-head"><h2>${t}</h2>${target?`<button class="text-btn" data-nav="${target}">View all ${icon('arrow')}</button>`:''}</div>${grid(xs)}</section>`;}
function rows(xs,playlist){const curId=player?.current()?.id,isPlaying=Boolean(player?.state?.playing);return xs.length?`<div class="tracks"><div class="track-head"><span>#</span><span>Title</span><span>Album</span><span></span><span>${icon('clock')}</span></div>${xs.map((s,i)=>{const isCur=curId&&String(curId)===String(s.id);return `<div class="track${isCur?' is-current'+(isPlaying?' is-playing':''):''}" data-play="${s.id}"><span class="track-num-col"><span class="track-num">${i+1}</span><span class="track-eq" aria-hidden="true"><span class="eq-bar bar-1"></span><span class="eq-bar bar-2"></span><span class="eq-bar bar-3"></span><span class="eq-bar bar-4"></span></span></span><button class="track-title" data-play="${s.id}">${art(s)}<span><strong>${safe(s.title)}</strong><small>${safe(s.artist)}</small></span></button><span class="track-album">${safe(s.album)}</span><span class="track-actions">${b('play-next','play',`Play next: ${s.title}`,`data-id="${s.id}"`)}${b('add-to-queue','queue',`Add ${s.title} to queue`,`data-id="${s.id}"`)}${b('like','heart',library.likes.includes(s.id)?'Unlike song':'Like song',`data-id="${s.id}" aria-pressed="${library.likes.includes(s.id)}"`)}${playlist?.personal?b('remove-track','close',`Remove ${s.title}`,`data-playlist-id="${playlist.id}" data-id="${s.id}"`):b('add-track','plus',`Add ${s.title} to playlist`,`data-id="${s.id}"`)}</span><span>${fmt(s.duration)}</span></div>`;}).join('')}</div>`:empty('Nothing to play yet','Tracks will appear here when you add them.');}
function chips(v,selected,act){return `<div class="chips">${v.map(x=>`<button data-act="${act}" data-id="${x}" aria-pressed="${selected===x}">${x}</button>`).join('')}</div>`;}
function getQuickPlayItems(){
  const items=[];const seen=new Set();
  const add=x=>{if(!x||!x.id||seen.has(x.id))return;seen.add(x.id);items.push(x);};
  recent().forEach(add);
  (library.playlists||[]).forEach(add);
  featured.forEach(add);
  playlists.forEach(add);
  albums.forEach(add);
  songs.forEach(add);
  return items.slice(0,6);
}
function home(){const spot=demo?playlists[0]:featured[0]||playlists[0],greeting=safe((settings.homepage_greeting?.trim()||'Good evening').replace(/[.!?]$/,''));const note=connection==='error'?`<div class="catalog-notice">Couldn’t load the catalog. ${safe(detail)}</div>`:connection==='setup'?'<div class="catalog-notice">Supabase is not configured. Open demo mode to preview the catalog.</div>':demo?'<div class="catalog-notice">Demo catalog · library changes stay in this browser.</div>':'';const filterBar=`<div class="home-filter-bar" role="tablist" aria-label="Home categories"><button type="button" class="home-filter-chip${homeCategory==='All'?' active':''}" data-act="home-filter" data-filter="All" role="tab" aria-selected="${homeCategory==='All'}" aria-pressed="${homeCategory==='All'}">All</button><button type="button" class="home-filter-chip${homeCategory==='Music'?' active':''}" data-act="home-filter" data-filter="Music" role="tab" aria-selected="${homeCategory==='Music'}" aria-pressed="${homeCategory==='Music'}">Music</button><button type="button" class="home-filter-chip${homeCategory==='Podcasts'?' active':''}" data-act="home-filter" data-filter="Podcasts" role="tab" aria-selected="${homeCategory==='Podcasts'}" aria-pressed="${homeCategory==='Podcasts'}">Podcasts</button></div>`;const quickItems=getQuickPlayItems();const quickHtml=quickItems.length?`<div class="quick-grid" role="region" aria-label="Quick play">${quickItems.map(x=>{const isSong=x.type==='song';return `<div class="quick-card"><button type="button" class="quick-nav-btn" ${isSong?`data-play="${x.id}"`:`data-nav="${x.id}"`} aria-label="${isSong?`Play ${safe(x.title)}`:`Open ${safe(x.title)}`}">${art(x)}<span class="quick-title">${safe(x.title)}</span></button><button type="button" class="quick-play-btn" ${isSong?`data-play="${x.id}"`:`data-act="play-list" data-id="${x.id}"`} aria-label="Play ${safe(x.title)}" title="Play ${safe(x.title)}">${icon('play')}</button></div>`;}).join('')}</div>`:'';const recentItems=recent();const recentShelf=recentItems.length?`<section class="shelf home-carousel"><div class="section-head"><h2>Recently Played</h2><button class="text-btn" data-nav="recent">View all ${icon('arrow')}</button></div>${grid(recentItems.slice(0,8))}</section>`:'';const exploreShelf=`<section class="shelf home-carousel"><div class="section-head"><h2>Explore Songs</h2><small>${songs.length} tracks</small></div>${grid(songs.slice(0,8))}</section>`;const playlistShelf=(library.playlists&&library.playlists.length)?`<section class="shelf home-carousel"><div class="section-head"><h2>Your Playlists</h2><button class="text-btn" data-nav="library">View all ${icon('arrow')}</button></div>${grid(library.playlists)}</section>`:'';if(homeCategory==='Podcasts'){const podcastTracks=songs.filter(s=>/podcast|story|spoken|interview|talk/i.test(s.genre||s.title||s.album||''));const podcastList=playlists.filter(p=>/podcast|talk|story/i.test(p.title||p.description||''));return `<div class="greeting"><h1>${greeting}<span>.</span></h1></div>${filterBar}${note}<section class="shelf home-carousel"><div class="section-head"><h2>Podcasts &amp; Spoken Word</h2></div>${podcastTracks.length?grid(podcastTracks):podcastList.length?grid(podcastList):empty('No podcasts yet','Podcasts and spoken word releases will appear here.')}</section>`;}if(homeCategory==='Music'){return `<div class="greeting"><h1>${greeting}<span>.</span></h1></div>${filterBar}${note}${quickHtml}${recentShelf}<div class="home-carousel">${section('Recently Added Albums',albums,'albums')}</div>${exploreShelf}${playlistShelf}<div class="home-carousel">${section('Artists to Explore',artists,'artists')}</div>`;}return `<div class="greeting"><h1>${greeting}<span>.</span></h1></div>${filterBar}${note}${quickHtml}<section class="hero"><div><p class="eyebrow">✦ &nbsp; CHIKU'S PLAY SPOTLIGHT</p><h2>${safe(spot?.title||'Your music. Your world.')}</h2><p>${safe(spot?.description||"Discover music published in the CHIKU'S PLAY catalog.")}</p><div class="hero-actions">${spot?.tracks?.length?`<button class="primary" data-act="play-list" data-id="${spot.id}">${icon('play')} Play mix</button>`:''}${spot?`<button class="secondary" data-nav="${spot.id}">Explore playlist ${icon('arrow')}</button>`:''}</div></div></section>${recentShelf}<div class="home-carousel">${section('Recently Added Albums',albums,'albums')}</div>${exploreShelf}${playlistShelf}<div class="home-carousel">${section('Artists to Explore',artists,'artists')}</div>`;}
function search(){const types={Songs:'song',Artists:'artist',Albums:'album',Playlists:'playlist'},words=query.trim().toLowerCase().split(/\s+/).filter(Boolean);const clearBtn=$('.search-clear');if(clearBtn)clearBtn.hidden=!query.trim();$('#search-chips').innerHTML=chips(['All','Songs','Artists','Albums','Playlists'],searchType,'search-filter');const resultsEl=$('#results');if(!words.length){const history=getSearchHistory(),historyHtml=history.length?`<section class="shelf recent-searches"><div class="section-head"><h2>Recent searches</h2><button class="text-btn" data-act="clear-recent-searches">Clear recent searches</button></div><div class="chips">${history.map(q=>`<button data-act="apply-search" data-query="${safe(q)}">${safe(q)}</button>`).join('')}</div></section>`:'';if(searchType==='All'){resultsEl.innerHTML=`${historyHtml}${featured.length?section('Featured Playlists',featured.slice(0,5),'playlists'):section('Popular Playlists',playlists.slice(0,5),'playlists')}${section('Popular Artists',artists.slice(0,5),'artists')}${section('Popular Albums',albums.slice(0,5),'albums')}`;}else if(searchType==='Songs'){resultsEl.innerHTML=`${historyHtml}<div class="section-head"><h2>All Songs</h2><small>${songs.length} songs</small></div>${rows(songs)}`;}else{const typeMatches=catalog().filter(x=>x.type===types[searchType]);resultsEl.innerHTML=`${historyHtml}<div class="section-head"><h2>Browse ${searchType}</h2><small>${typeMatches.length} ${typeMatches.length===1?'item':'items'}</small></div>${grid(typeMatches)}`;}return;}const matches=catalog().filter(x=>words.every(w=>[x.title,x.artist,x.album,x.description,x.genre].filter(Boolean).join(' ').toLowerCase().includes(w)));if(searchType==='All'){const songMatches=matches.filter(x=>x.type==='song'),artistMatches=matches.filter(x=>x.type==='artist'),albumMatches=matches.filter(x=>x.type==='album'),playlistMatches=matches.filter(x=>x.type==='playlist');if(!matches.length){resultsEl.innerHTML=empty(`No results found for “${safe(query.trim())}”`,'Try a different title, artist, album or playlist.');return;}let html='';if(songMatches.length){html+=`<section class="shelf"><div class="section-head"><h2>Songs</h2><button class="text-btn" data-act="view-all-songs">View all ${songMatches.length} ${songMatches.length===1?'song':'songs'} ${icon('arrow')}</button></div>${rows(songMatches.slice(0,5))}</section>`;}if(artistMatches.length){html+=`<section class="shelf"><div class="section-head"><h2>Artists</h2><small>${artistMatches.length} ${artistMatches.length===1?'artist':'artists'}</small></div>${grid(artistMatches)}</section>`;}if(albumMatches.length){html+=`<section class="shelf"><div class="section-head"><h2>Albums</h2><small>${albumMatches.length} ${albumMatches.length===1?'album':'albums'}</small></div>${grid(albumMatches)}</section>`;}if(playlistMatches.length){html+=`<section class="shelf"><div class="section-head"><h2>Playlists</h2><small>${playlistMatches.length} ${playlistMatches.length===1?'playlist':'playlists'}</small></div>${grid(playlistMatches)}</section>`;}resultsEl.innerHTML=html;if(query.trim().startsWith('@')){const handleQuery=query.trim().replace(/^@/,'').toLowerCase();getPublicProfile(handleQuery).then(prof=>{if(!prof||query.trim().replace(/^@/,'').toLowerCase()!==handleQuery)return;const existing=$('#results .profiles-shelf');if(existing)existing.remove();const div=document.createElement('div');div.className='profiles-shelf';div.innerHTML=`<section class="shelf"><div class="section-head"><h2>Profiles</h2><small>1 user</small></div><div class="cards"><a class="card profile-card" href="#profile/@${safe(prof.username)}" data-nav="profile/@${safe(prof.username)}"><div class="art circle-art">${safe((prof.display_name||prof.username)[0].toUpperCase())}</div><strong>${safe(prof.display_name||prof.username)}</strong><small>@${safe(prof.username)}</small></a></div></section>`;$('#results')?.prepend(div);}).catch(()=>{});}}else{const typeMatches=matches.filter(x=>x.type===types[searchType]);if(!typeMatches.length){resultsEl.innerHTML=empty(`No ${searchType.toLowerCase()} found for “${safe(query.trim())}”`,'Try a different search term or select All.');return;}const countLabel=searchType==='Songs'?`${typeMatches.length} ${typeMatches.length===1?'song':'songs'}`:searchType==='Artists'?`${typeMatches.length} ${typeMatches.length===1?'artist':'artists'}`:searchType==='Albums'?`${typeMatches.length} ${typeMatches.length===1?'album':'albums'}`:`${typeMatches.length} ${typeMatches.length===1?'playlist':'playlists'}`;resultsEl.innerHTML=`<div class="section-head"><h2>${searchType}</h2><small>${countLabel}</small></div>${searchType==='Songs'?rows(typeMatches):grid(typeMatches)}`;}}
function paintLibrary(){const lists={'Created Playlists':library.playlists,'Liked Songs':liked(),'Following':followed(),'Recently Played':recent()};$('#library-body').innerHTML=chips(['All',...Object.keys(lists)],libraryType,'library-filter')+(libraryType==='All'?Object.entries(lists).map(([n,x])=>section(n,x,n==='Liked Songs'?'liked':n==='Recently Played'?'recent':n==='Following'?'following':null)).join(''):grid(lists[libraryType],libraryType==='Following'?'Follow artists from the catalog to see them here.':'Build your personal collection from the catalog.'));}
function detailPage(x){const tracks=x.tracks.map(find).filter(Boolean),personal=!!x.personal,isArtist=x.type==='artist',isFollowing=isArtist&&(library.following||[]).includes(x.id);const followerHtml=isArtist?` · <span id="artist-follower-count" class="follower-count">${formatFollowers(followerCountsCache.get(x.id))}</span>`:'';return `<section class="detail" style="--detail-color:${x.color}">${art(x)}<div><p class="eyebrow">${x.type.toUpperCase()}</p><h1>${safe(x.title)}</h1><p>${safe(x.description||x.artist||'')}</p><small>${tracks.length} ${tracks.length===1?'song':'songs'}${personal?` · <span class="badge-${x.isPublic?'public':'private'}">${x.isPublic?'Public':'Private'}</span>`:''}${followerHtml}</small></div></section><div class="detail-actions">${tracks.length?`<button class="primary" data-act="play-list" data-id="${x.id}">${icon('play')} ${isArtist?'Play mix':'Play playlist'}</button>`:''}${isArtist?`<button type="button" class="secondary follow-btn" data-act="follow-artist" data-id="${x.id}" aria-pressed="${isFollowing}" aria-label="${isFollowing?'Unfollow '+safe(x.title):'Follow '+safe(x.title)}">${isFollowing?icon('user')+' Following':icon('plus')+' Follow'}</button>`:''}${personal?`<button class="secondary" data-act="edit-playlist" data-id="${x.id}">Edit playlist</button><button class="secondary" data-act="add-tracks" data-id="${x.id}">Add tracks</button><button class="secondary danger" data-act="delete-playlist" data-id="${x.id}">Delete</button>`:''}</div>${rows(tracks,personal?x:null)}`;}
function active(){document.querySelectorAll('.nav-link[data-nav],.playlists [data-nav]').forEach(x=>{const yes=x.dataset.nav===page||(x.dataset.nav==='library'&&['liked','recent','following'].includes(page));x.classList.toggle('active',yes);x.toggleAttribute('aria-current',yes);});}
async function renderPublicProfile(identifier){
  const raw=String(identifier||'').trim();
  const clean=raw.replace(/^@/,'');
  const v=$('#view');
  v.innerHTML=`<div class="loader-wrap" role="status" aria-label="Loading profile"><div class="skeleton-profile-header"><div class="skeleton skeleton-avatar"></div><div class="skeleton-profile-meta"><div class="skeleton skeleton-title"></div><div class="skeleton skeleton-handle"></div></div></div><div class="loader"></div><p class="muted">Loading profile…</p></div>`;
  let prof=null;
  try{
    prof=await getPublicProfile(clean);
  }catch(e){
    console.warn('Public profile fetch error:',e);
  }
  if(!prof){
    v.innerHTML=empty('Profile not found',`No user found matching “${safe(raw)}”.`)+`<div style="margin-top:16px;text-align:center"><button class="primary" data-nav="home">Back to Home</button></div>`;
    return;
  }
  const isOwner=Boolean(session?.user?.id && prof.id===session.user.id);
  const n=safe(prof.display_name||prof.username||'User');
  let avatarSrc=null;
  try{
    avatarSrc=await getAvatarUrl(prof.avatar_path,prof.avatar_url);
  }catch{
    avatarSrc=prof.avatar_url;
  }
  const avatarHtml=avatarSrc?`<img src="${safe(avatarSrc)}" alt="${n}">`:safe((n[0]||'U').toUpperCase());
  let joinDate='';
  if(prof.created_at){
    try{
      const d=new Date(prof.created_at);
      joinDate=d.toLocaleDateString('en-US',{month:'long',year:'numeric'});
    }catch{}
  }
  let userPlaylists=[];
  try{
    userPlaylists=await loadUserPublicPlaylists(prof.id,songs);
    for(const p of userPlaylists) publicPlaylistsCache.set(p.id,p);
  }catch(e){
    console.warn('Could not load public playlists:',e);
  }
  const ownerActions=isOwner?`<div class="profile-actions"><button type="button" class="secondary" data-act="open-edit-profile">${icon('plus')} Edit Profile</button><a href="#settings" class="secondary" data-nav="settings">${icon('queue')} Settings</a></div>`:'';
  const bioHtml=prof.bio?.trim()
    ?`<p class="profile-bio-text">${safe(prof.bio.trim())}</p>`
    :isOwner?`<p class="profile-bio-text empty-bio">No bio yet. <button class="text-btn" data-act="open-edit-profile">Add a bio ${icon('arrow')}</button></p>`:'';
  const joinDateHtml=joinDate?`<span class="profile-join-date">${icon('clock')} Member since ${safe(joinDate)}</span>`:'';

  v.innerHTML=`
    <section class="profile-header">
      <div class="profile-avatar-wrap">
        <div class="avatar profile-avatar-art">${avatarHtml}</div>
      </div>
      <div class="profile-info">
        <p class="eyebrow">PROFILE</p>
        <h1 class="profile-name">${n}</h1>
        <div class="profile-meta-row">
          ${prof.username?`<span class="profile-meta-handle">@${safe(prof.username)}</span>`:''}
          ${prof.username&&joinDateHtml?'<span class="meta-dot">·</span>':''}
          ${joinDateHtml}
        </div>
        ${bioHtml}
        ${ownerActions}
      </div>
    </section>
    <section class="shelf">
      <div class="section-head">
        <h2>Public Playlists</h2>
        <small>${userPlaylists.length} ${userPlaylists.length===1?'playlist':'playlists'}</small>
      </div>
      ${userPlaylists.length?grid(userPlaylists):'<p class="muted">No public playlists published yet.</p>'}
    </section>
  `;
}

async function renderSettings(){
  if(!session?.user){
    if(demo){
      session={
        user:{
          id:'demo-user-id',
          email:'listener@soundify.test',
          user_metadata:{full_name:'Soundify Listener'}
        }
      };
      if(!currentProfile){
        currentProfile={
          id:'demo-user-id',
          display_name:'Soundify Listener',
          username:'soundify_listener',
          bio:"Electronic music enthusiast & CHIKU'S PLAY explorer.",
          created_at:'2024-01-15T12:00:00Z'
        };
      }
    }else{
      if(typeof location.replace==='function')location.replace('login.html');
      else location.href='login.html';
      return;
    }
  }
  const v=$('#view');
  const n=safe(displayNameFor(session.user,currentProfile));
  const username=currentProfile?.username||'';
  const email=session.user.email||'';
  let joinDate='';
  if(currentProfile?.created_at){
    try{
      const d=new Date(currentProfile.created_at);
      joinDate=d.toLocaleDateString('en-US',{month:'long',year:'numeric'});
    }catch{}
  }
  const normalize=localStorage.getItem('soundify-pref-normalize')!=='false';
  const autoplay=localStorage.getItem('soundify-pref-autoplay')!=='false';
  const quality=localStorage.getItem('soundify-pref-quality')||'high';
  const isCrossfadeSupported=typeof player.checkCrossfadeSupport==='function'?player.checkCrossfadeSupport():true;
  const crossfadePref=parseInt(localStorage.getItem('soundify-pref-crossfade'),10)||0;
  let avatarSrc=null;
  try{
    avatarSrc=await getAvatarUrl(currentProfile?.avatar_path,currentProfile?.avatar_url||session.user.user_metadata?.avatar_url);
  }catch{
    avatarSrc=currentProfile?.avatar_url||session.user.user_metadata?.avatar_url||null;
  }
  const avatarHtml=avatarSrc?`<img src="${safe(avatarSrc)}" alt="">`:safe((n[0]||'A').toUpperCase());
  const profileNav=username?`profile/@${username}`:`profile/${session.user.id}`;

  v.innerHTML=`
    ${heading('Settings','ACCOUNT &amp; PREFERENCES')}
    <div class="settings-container">
      <section class="settings-section">
        <h2>Account Information</h2>
        <div class="settings-card">
          <div class="settings-user-row">
            <div class="avatar avatar-md">${avatarHtml}</div>
            <div class="settings-user-info">
              <strong>${n}</strong>
              ${username?`<small class="profile-handle">@${safe(username)}</small>`:''}
              ${joinDate?`<small class="muted">Joined ${safe(joinDate)}</small>`:''}
            </div>
            <div class="settings-user-actions">
              <button type="button" class="secondary" data-act="open-edit-profile">${icon('plus')} Edit Profile</button>
            </div>
          </div>
          <div class="settings-row">
            <div>
              <strong>Email Address</strong>
              <small class="muted">Associated with your Google Account</small>
            </div>
            <div class="settings-row-value">
              <span>${safe(email)}</span>
              <span class="badge-private">${icon('lock')} Private</span>
            </div>
          </div>
          <div class="settings-row">
            <div>
              <strong>Public Profile</strong>
              <small class="muted">How others see your profile and playlists</small>
            </div>
            <div class="settings-row-value">
              <a href="#${profileNav}" data-nav="${profileNav}" class="secondary">View Public Profile ${icon('arrow')}</a>
            </div>
          </div>
        </div>
      </section>

      <section class="settings-section">
        <h2>Playback Preferences</h2>
        <div class="settings-card">
          <div class="settings-row toggle-row">
            <div>
              <strong>Normalize Volume</strong>
              <small class="muted">Set the same volume level for all tracks (Preview preference · Loudness normalization planned)</small>
            </div>
            <label class="toggle-switch" aria-label="Normalize Volume">
              <input type="checkbox" id="pref-normalize" ${normalize?'checked':''} data-act="toggle-pref" data-pref="normalize">
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="settings-row toggle-row">
            <div>
              <strong>Autoplay</strong>
              <small class="muted">Keep listening to similar songs when your music ends</small>
            </div>
            <label class="toggle-switch" aria-label="Autoplay">
              <input type="checkbox" id="pref-autoplay" ${autoplay?'checked':''} data-act="toggle-pref" data-pref="autoplay">
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="settings-row">
            <div>
              <strong>Audio Streaming Quality</strong>
              <small class="muted">Catalog streams at source upload quality (Multi-bitrate transcoding planned)</small>
            </div>
            <div class="settings-row-value">
              <select id="pref-quality" class="settings-select" data-act="change-pref-quality" aria-label="Audio Streaming Quality">
                <option value="normal" ${quality==='normal'?'selected':''}>Normal (Source quality)</option>
                <option value="high" ${quality==='high'?'selected':''}>High (Source quality)</option>
                <option value="lossless" ${quality==='lossless'?'selected':''}>Lossless (Source quality)</option>
              </select>
            </div>
          </div>
          <div class="settings-row">
            <div>
              <strong>Crossfade Songs</strong>
              <small class="muted">${isCrossfadeSupported?'Allows a smooth transition between songs':'Not supported on this device/browser'}</small>
            </div>
            <div class="settings-row-value">
              <select id="pref-crossfade" class="settings-select" data-act="change-pref-crossfade" aria-label="Crossfade Songs" ${isCrossfadeSupported?'':'disabled aria-disabled="true"'}>
                <option value="0" ${crossfadePref===0?'selected':''}>Off</option>
                <option value="2" ${crossfadePref===2?'selected':''}>2 seconds</option>
                <option value="4" ${crossfadePref===4?'selected':''}>4 seconds</option>
                <option value="6" ${crossfadePref===6?'selected':''}>6 seconds</option>
              </select>
            </div>
          </div>
        </div>
      </section>

      <section class="settings-section">
        <h2>Appearance &amp; Theme</h2>
        <div class="settings-card">
          <div class="settings-row">
            <div>
              <strong>Color Theme</strong>
              <small class="muted">Select your preferred viewing experience</small>
            </div>
            <div class="settings-row-value">
              <select id="pref-theme" class="settings-select" data-act="change-pref-theme" aria-label="Color Theme">
                <option value="dark" ${currentTheme==='dark'?'selected':''}>Dark mode</option>
                <option value="light" ${currentTheme==='light'?'selected':''}>Light mode</option>
                <option value="system" ${currentTheme==='system'?'selected':''}>System default</option>
              </select>
            </div>
          </div>
          <div class="settings-row">
            <div>
              <strong>Accent Color</strong>
              <small class="muted">Personalize CHIKU'S PLAY with your signature color</small>
            </div>
            <div class="settings-row-value">
              <div class="accent-picker" role="radiogroup" aria-label="Accent Color">
                <button type="button" class="accent-dot ${currentAccent==='green'?'selected':''}" data-act="set-accent" data-accent="green" style="background:#1ed760" aria-label="Emerald Green" title="Emerald Green" aria-checked="${currentAccent==='green'}"></button>
                <button type="button" class="accent-dot ${currentAccent==='blue'?'selected':''}" data-act="set-accent" data-accent="blue" style="background:#3b82f6" aria-label="Electric Blue" title="Electric Blue" aria-checked="${currentAccent==='blue'}"></button>
                <button type="button" class="accent-dot ${currentAccent==='purple'?'selected':''}" data-act="set-accent" data-accent="purple" style="background:#a855f7" aria-label="Royal Purple" title="Royal Purple" aria-checked="${currentAccent==='purple'}"></button>
                <button type="button" class="accent-dot ${currentAccent==='pink'?'selected':''}" data-act="set-accent" data-accent="pink" style="background:#ec4899" aria-label="Rose Pink" title="Rose Pink" aria-checked="${currentAccent==='pink'}"></button>
                <button type="button" class="accent-dot ${currentAccent==='orange'?'selected':''}" data-act="set-accent" data-accent="orange" style="background:#f97316" aria-label="Sunset Orange" title="Sunset Orange" aria-checked="${currentAccent==='orange'}"></button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="settings-section">
        <h2>Account Actions</h2>
        <div class="settings-card">
          <div class="settings-row action-row">
            <div>
              <strong>Sign out</strong>
              <small class="muted">Log out of your CHIKU'S PLAY session on this device</small>
            </div>
            <button type="button" class="secondary danger" data-act="sign-out">Sign out</button>
          </div>
        </div>
      </section>
    </div>
  `;
}

async function renderDiscover(){
  const v=$('#view');
  v.innerHTML=`<div class="loader-wrap" role="status" aria-label="Loading recommendations"><div class="skeleton-discovery-row"><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div></div><div class="loader"></div><p class="muted">Loading recommendations…</p></div>`;
  let trendingIds=[],popularIds=[];
  try{
    [trendingIds,popularIds]=await Promise.all([
      getTrendingTrackIds(10),
      getPopularArtistIds(8)
    ]);
  }catch(err){
    console.warn('Discovery RPC error:',err);
  }
  if(page!=='discover')return;
  const trendingTracks=trendingIds.map(find).filter(Boolean);
  const popularArtists=popularIds.map(find).filter(Boolean);

  const recs=computePersonalizedRecommendations(songs,library,10);
  const madeForYouHtml=recs.length
    ?`<section class="shelf"><div class="section-head"><h2>Made for You</h2><small class="badge-recommendation">Personalized for you</small></div>${rows(recs)}</section>`
    :'';

  const trendingHtml=trendingTracks.length
    ?`<section class="shelf"><div class="section-head"><h2>Trending Music</h2><small>Trending now</small></div>${rows(trendingTracks)}</section>`
    :`<section class="shelf"><div class="section-head"><h2>Explore Songs</h2><small>Popular picks</small></div>${rows(songs.slice(0,10))}</section>`;

  const newReleases=getNewReleases(data,8);
  const newReleasesHtml=`<section class="shelf"><div class="section-head"><h2>New Releases</h2><small>Latest singles &amp; albums</small></div>${grid(newReleases)}</section>`;

  const artistsHtml=popularArtists.length
    ?section('Popular Artists',popularArtists,'artists')
    :section('Artists to Explore',artists.slice(0,8),'artists');

  const recAlbums=getRecommendedAlbums(albums,songs,library,6);
  const albumsHtml=recAlbums.length
    ?section('Recommended Albums',recAlbums,'albums')
    :section('Recently Added Albums',albums.slice(0,6),'albums');

  const genres=getGenreBreakdown(data);
  const genreGridHtml=genres.length
    ?`<section class="shelf"><div class="section-head"><h2>Discover by Genre</h2><small>${genres.length} genres</small></div><div class="genre-grid">${genres.map(g=>`<button type="button" class="genre-pill" data-act="discover-genre" data-genre="${safe(g.name)}" style="--genre-color:${g.color}"><span class="genre-name">${safe(g.name)}</span><span class="genre-count">${g.songCount} ${g.songCount===1?'track':'tracks'}</span></button>`).join('')}</div></section>`
    :'';

  v.innerHTML=`
    ${heading('Discover','MUSIC DISCOVERY')}
    <div class="discovery-content">
      ${madeForYouHtml}
      ${trendingHtml}
      ${newReleasesHtml}
      ${artistsHtml}
      ${albumsHtml}
      ${genreGridHtml}
    </div>
  `;
}

function render(dest){page=dest;active();const v=$('#view');if(dest==='settings'){renderSettings();return;}if(dest==='discover'){renderDiscover();return;}if(dest.startsWith('profile/')||dest.startsWith('@')){renderPublicProfile(dest.replace(/^profile\//,''));return;}if(dest==='search'){v.innerHTML=`${heading('Search')}<div class="search-field">${icon('search')}<input id="search-input" type="search" placeholder="Search songs, artists, albums and playlists" aria-label="Search catalog"><button type="button" class="search-clear icon-btn" data-act="clear-search" aria-label="Clear search query" title="Clear search query" ${query?'':'hidden'}>${icon('close')}</button></div><div id="search-chips"></div><section id="results" class="shelf"></section>`;const input=$('#search-input');if(input){input.value=query;search();input.focus();}return;}if(dest==='library'){v.innerHTML=`${heading('Your Library','YOUR COLLECTION')}<div class="library-actions"><button class="secondary" data-act="create-playlist">${icon('plus')} Create Playlist</button><a class="secondary" href="#liked" data-nav="liked">${icon('heart')} Liked Songs</a><a class="secondary" href="#following" data-nav="following">${icon('user')} Following</a></div><div id="library-body"></div>`;paintLibrary();return;}if(dest==='liked'){v.innerHTML=heading('Liked Songs','YOUR COLLECTION')+rows(liked());return;}if(dest==='following'){v.innerHTML=heading('Following','YOUR COLLECTION')+grid(followed(),'Follow artists from the catalog to see them here.');return;}if(dest==='recent'){v.innerHTML=heading('Recently Played','YOUR COLLECTION')+rows(recent());return;}if(dest==='albums'){v.innerHTML=heading('Popular Albums')+grid(albums);return;}if(dest==='artists'){v.innerHTML=heading('Popular Artists')+grid(artists);return;}const x=find(dest);v.innerHTML=x?.tracks?detailPage(x):home();if(x?.tracks&&x.type==='artist'){getArtistFollowerCount(x.id).then(count=>{followerCountsCache.set(x.id,count);const el=$('#artist-follower-count');if(el)el.innerHTML=formatFollowers(count);}).catch(e=>console.warn('Could not load follower count:',e));}if(!x?.tracks&&dest!=='home'){page='home';active();}updateActiveTrackIndicators(player?.current()?.id||null,Boolean(player?.state?.playing),true);}

$('#top').innerHTML=`<div class="history">${b('back','back','Go back')}${b('forward','forward','Go forward')}</div><div class="mobile-brand"><a class="brand" href="#home" data-nav="home"><img src="assets/icons/logo.svg" alt="">${safe(brand)}<span>.</span></a></div><button class="search-entry" data-nav="search">${icon('search')}<span>What do you want to listen to?</span></button><div class="top-right"><details id="profile"><summary aria-label="Account menu"><span class="avatar"></span><span class="guest-label">Account</span>${icon('down')}</summary></details></div>`;
$('#mobile').innerHTML=link('home','home','Home')+link('discover','library','Discover')+link('search','search','Search')+link('library','library','Library');
$('#player').innerHTML=`<div class="mini-progress" aria-hidden="true"><div class="mini-progress-fill" id="mini-progress-fill"></div></div><div class="now"><div id="now-art" role="button" tabindex="0" data-act="open-fullscreen" aria-label="Open full screen" title="Expand (F)"></div><div class="now-copy"><strong id="now-title"></strong><small id="now-artist"></small></div><span id="now-eq" class="now-eq" aria-hidden="true"><span class="eq-bar bar-1"></span><span class="eq-bar bar-2"></span><span class="eq-bar bar-3"></span><span class="eq-bar bar-4"></span></span>${b('player-like','heart','Like song')}</div><div class="transport"><div class="controls">${b('shuffle','shuffle','Shuffle')}${b('prev','prev','Previous track')}${b('play','play','Play')}${b('next','next','Next track')}${b('repeat','repeat','Repeat')}</div><div class="timeline"><span id="elapsed"></span><input type="range" min="0" value="0" aria-label="Playback progress" id="time"><span id="duration"></span></div></div><div class="audio-controls"><button type="button" class="icon-btn speed-btn" data-act="open-speed" aria-label="Playback speed" title="Playback speed"><span id="speed-label">1x</span></button>${b('open-sleep-timer','clock','Sleep timer')}${b('toggle-queue','queue','Queue')}${b('open-fullscreen','expand','Full screen (F)')}${b('muted','volume','Mute')}<input id="volume" type="range" min="0" max="100" aria-label="Volume"></div>`;
const player=createPlayer(songs,paintPlayer,async id=>{if(demo||!session?.user){library.recent=[id,...library.recent.filter(x=>x!==id)].slice(0,30);save('recent',library.recent);}if(!demo&&session?.user){try{await recordRecentlyPlayed(id);await refreshLibrary();}catch(e){console.warn(e);}}if(['home','recent','library','discover'].includes(page))render(page);});
const initialCrossfade=parseInt(localStorage.getItem('soundify-pref-crossfade'),10)||0;
if(typeof player.setCrossfade==='function')player.setCrossfade(initialCrossfade);
const DEFAULT_DOCUMENT_TITLE="CHIKU'S PLAY — Web Player: Listen to Music";
let currentDocumentTitle=DEFAULT_DOCUMENT_TITLE;
function updateDocumentTitle(track,isPlaying){
  const nextTitle=(track&&isPlaying)?`${track.title} • ${track.artist} — CHIKU'S PLAY`:DEFAULT_DOCUMENT_TITLE;
  if(currentDocumentTitle!==nextTitle){
    currentDocumentTitle=nextTitle;
    document.title=nextTitle;
  }
}
let lastEqState={trackId:null,isPlaying:false};
function updateActiveTrackIndicators(currentTrackId,isPlaying,force=false){
  if(!force&&lastEqState.trackId===currentTrackId&&lastEqState.isPlaying===isPlaying)return;
  lastEqState.trackId=currentTrackId;
  lastEqState.isPlaying=isPlaying;
  document.querySelectorAll('.track[data-play]').forEach(el=>{
    const isCurrent=currentTrackId!==null&&String(el.dataset.play)===String(currentTrackId);
    el.classList.toggle('is-current',isCurrent);
    el.classList.toggle('is-playing',isCurrent&&isPlaying);
  });
  document.querySelectorAll('.card[data-play]').forEach(el=>{
    const isCurrent=currentTrackId!==null&&String(el.dataset.play)===String(currentTrackId);
    el.classList.toggle('is-current',isCurrent);
    el.classList.toggle('is-playing',isCurrent&&isPlaying);
  });
  document.querySelectorAll('.quick-card').forEach(el=>{
    const btn=el.querySelector('[data-play]');
    const isCurrent=btn&&currentTrackId!==null&&String(btn.dataset.play)===String(currentTrackId);
    el.classList.toggle('is-current',Boolean(isCurrent));
    el.classList.toggle('is-playing',Boolean(isCurrent&&isPlaying));
  });
  const nowEq=$('#now-eq');
  if(nowEq){
    nowEq.classList.toggle('is-active',Boolean(currentTrackId));
    nowEq.classList.toggle('is-playing',Boolean(currentTrackId&&isPlaying));
  }
  const qEq=document.querySelector('#queue .queue-eq, #fullscreen-queue-drawer .queue-eq');
  if(qEq){
    qEq.classList.toggle('is-playing',Boolean(currentTrackId&&isPlaying));
  }
}
function paintPlayer(){
  const s=player.current(),p=player.state;
  if(!s){
    updateDocumentTitle(null,false);
    updateActiveTrackIndicators(null,false);
    const artEl=$('#now-art');if(artEl)artEl.innerHTML='';
    const titleEl=$('#now-title');if(titleEl)titleEl.textContent='';
    const artistEl=$('#now-artist');if(artistEl)artistEl.textContent='';
    const elEl=$('#elapsed');if(elEl)elEl.textContent='0:00';
    const durEl=$('#duration');if(durEl)durEl.textContent='0:00';
    const timeEl=$('#time');
    if(timeEl){
      timeEl.value=0;
      timeEl.max=0;
      timeEl.setAttribute('aria-valuenow','0');
      timeEl.setAttribute('aria-valuemin','0');
      timeEl.setAttribute('aria-valuemax','0');
      timeEl.setAttribute('aria-valuetext','0 minutes, 0 seconds of 0 minutes, 0 seconds');
      timeEl.style.setProperty('--pct','0%');
    }
    const volEl=$('#volume');
    if(volEl){
      const volVal=p.muted?0:p.volume;
      volEl.style.setProperty('--pct',`${volVal}%`);
    }
    const set=(a,l,i,pressed)=>{const x=$(`#player [data-act="${a}"]`);if(!x)return;x.setAttribute('aria-label',l);x.title=l;if(i)x.innerHTML=icon(i);if(pressed!==undefined)x.setAttribute('aria-pressed',pressed);};
    set('play','Play','play',false);
    set('player-like','Like song','heart',false);
    const speedLabel=$('#speed-label');if(speedLabel)speedLabel.textContent='1x';
    const miniBar=$('#mini-progress-fill');if(miniBar)miniBar.style.setProperty('--pct','0%');
    const sleepBtn=$('#player [data-act="open-sleep-timer"]');if(sleepBtn){sleepBtn.classList.remove('has-timer');sleepBtn.setAttribute('aria-label','Sleep timer');sleepBtn.title='Sleep timer';}
    const qEl=$('#queue');if(qEl&&!qEl.hidden)paintQueue();
    if($('#fullscreen-player')?.open){try{$('#fullscreen-player').close();}catch{}}
    return;
  }
  updateDocumentTitle(s,p.playing);
  updateActiveTrackIndicators(s.id,p.playing);
  const miniBar=$('#mini-progress-fill');if(miniBar)miniBar.style.setProperty('--pct',`${(100*(p.time||0))/(s.duration||1)}%`);
  $('#now-art').innerHTML=art(s);$('#now-title').textContent=s.title;$('#now-artist').textContent=s.artist;$('#elapsed').textContent=fmt(p.time);$('#duration').textContent=fmt(s.duration);const timeEl=$('#time');if(timeEl){timeEl.max=s.duration;timeEl.value=p.time;timeEl.setAttribute('aria-valuenow',p.time);timeEl.setAttribute('aria-valuemin',0);timeEl.setAttribute('aria-valuemax',s.duration);const m=Math.floor(p.time/60),sec=p.time%60,durM=Math.floor(s.duration/60),durSec=s.duration%60;timeEl.setAttribute('aria-valuetext',`${m} minute${m===1?'':'s'}, ${sec} second${sec===1?'':'s'} of ${durM} minute${durM===1?'':'s'}, ${durSec} second${durSec===1?'':'s'}`);}const volEl=$('#volume');if(volEl){const volVal=p.muted?0:p.volume;volEl.value=volVal;volEl.setAttribute('aria-valuenow',volVal);volEl.setAttribute('aria-valuemin',0);volEl.setAttribute('aria-valuemax',100);volEl.setAttribute('aria-valuetext',p.muted?'Muted, 0 percent':`${volVal} percent`);}for(const k of ['time','volume'])$(`#${k}`)?.style.setProperty('--pct',`${100*($(`#${k}`)?.value||0)/($(`#${k}`)?.max||1)}%`);const set=(a,l,i,pressed)=>{const x=$(`#player [data-act="${a}"]`);if(!x)return;x.setAttribute('aria-label',l);x.title=l;if(i)x.innerHTML=icon(i);if(pressed!==undefined)x.setAttribute('aria-pressed',pressed);};set('play',p.playing?'Pause':'Play',p.playing?'pause':'play');set('muted',p.muted?'Unmute':'Mute',p.muted?'muted':'volume',p.muted);set('shuffle','Shuffle',null,p.shuffle);set('repeat','Repeat',null,p.repeat);set('player-like',library.likes.includes(s.id)?'Unlike song':'Like song','heart',library.likes.includes(s.id));const qEl=$('#queue');const isQueueOpen=Boolean(qEl&&!qEl.hidden);set('toggle-queue','Queue',null,isQueueOpen);const sleepBtn=$('#player [data-act="open-sleep-timer"]');if(sleepBtn){if(p.sleepDeadline){const remSec=Math.max(0,Math.round((p.sleepDeadline-Date.now())/1000));const remMin=Math.ceil(remSec/60);sleepBtn.classList.add('has-timer');sleepBtn.setAttribute('aria-label',`Sleep timer: ${remMin}m remaining`);sleepBtn.title=`Sleep timer: ${remMin}m remaining`;}else if(p.sleepEndOfTrack){sleepBtn.classList.add('has-timer');sleepBtn.setAttribute('aria-label','Sleep timer: End of track');sleepBtn.title='Sleep timer: End of track';}else{sleepBtn.classList.remove('has-timer');sleepBtn.setAttribute('aria-label','Sleep timer');sleepBtn.title='Sleep timer';}}const speedLabel=$('#speed-label');if(speedLabel)speedLabel.textContent=`${p.playbackRate||1}x`;const speedBtn=$('#player [data-act="open-speed"]');if(speedBtn){speedBtn.setAttribute('aria-label',`Playback speed ${p.playbackRate||1}x`);speedBtn.title=`Playback speed ${p.playbackRate||1}x`;if(p.playbackRateSupported===false)speedBtn.setAttribute('aria-disabled','true');}if(isQueueOpen)paintQueue();if($('#fullscreen-player')?.open)paintFullscreenPlayer();}
let lastQueueTrigger=null;
function toggleQueueDrawer(){const qEl=$('#queue');if(!qEl)return;const willOpen=qEl.hidden;if(willOpen){lastQueueTrigger=document.activeElement;qEl.hidden=false;paintQueue();const closeBtn=qEl.querySelector('[data-act="close-queue"]');if(closeBtn)closeBtn.focus();}else{closeQueueDrawer();}paintPlayer();}
function closeQueueDrawer(){const qEl=$('#queue');if(!qEl||qEl.hidden)return;qEl.hidden=true;paintPlayer();if(lastQueueTrigger&&typeof lastQueueTrigger.focus==='function'){try{lastQueueTrigger.focus();}catch{}}}
function renderQueueContent(container){if(!container)return;const details=player.getQueueDetails();const currentSong=player.current();let currentHtml='';if(currentSong){currentHtml=`<div class="queue-row is-current" data-uid="${details.currentUid||''}"><div class="queue-row-main" aria-label="Currently playing: ${safe(currentSong.title)} by ${safe(currentSong.artist)}">${art(currentSong)}<div class="queue-copy"><strong>${safe(currentSong.title)}</strong><small>${safe(currentSong.artist)}</small></div></div><span class="queue-indicator" aria-label="Now playing"><span class="queue-eq${player?.state?.playing?' is-playing':''}" aria-hidden="true"><span class="eq-bar bar-1"></span><span class="eq-bar bar-2"></span><span class="eq-bar bar-3"></span><span class="eq-bar bar-4"></span></span></span></div>`;}else{currentHtml='<p class="muted queue-empty">No track currently playing.</p>';}const upcomingItems=details.upcoming||[];let upcomingHtml='';if(upcomingItems.length){upcomingHtml=upcomingItems.map(item=>{const song=find(item.trackId)||songs.find(s=>s.id===item.trackId);if(!song)return '';const isManual=item.origin==='manual';return `<div class="queue-row" data-uid="${item.uid}"><button type="button" class="queue-row-main" data-act="select-queue-item" data-uid="${item.uid}" aria-label="Play ${safe(song.title)} by ${safe(song.artist)}">${art(song)}<div class="queue-copy"><strong>${safe(song.title)}</strong><small>${safe(song.artist)}</small></div>${isManual?'<span class="queue-badge">Next up</span>':''}</button><button type="button" class="icon-btn queue-remove-btn" data-act="remove-queue-item" data-uid="${item.uid}" aria-label="Remove ${safe(song.title)} from queue" title="Remove from queue">${icon('close')}</button></div>`;}).join('');}else{upcomingHtml='<p class="muted queue-empty">No upcoming tracks in queue.</p>';}const isFs=container.id==='fullscreen-queue-drawer';container.innerHTML=`<div class="queue-head"><h3 id="${container.id}-heading">Play Queue</h3><div class="queue-head-actions">${upcomingItems.length?'<button type="button" class="text-btn" data-act="clear-upcoming" aria-label="Clear upcoming tracks">Clear</button>':''}<button type="button" class="icon-btn" data-act="${isFs?'close-fullscreen-queue':'close-queue'}" aria-label="Close queue" title="Close queue">${icon('close')}</button></div></div><div class="queue-body"><div class="queue-group"><h4>Now Playing</h4><div class="queue-list">${currentHtml}</div></div><div class="queue-group"><h4>Next Up</h4><div class="queue-list">${upcomingHtml}</div></div></div>`;}
function paintQueue(){const qEl=$('#queue');if(qEl&&!qEl.hidden)renderQueueContent(qEl);const fsQueue=$('#fullscreen-queue-drawer');if(fsQueue&&!fsQueue.hidden)renderQueueContent(fsQueue);}
let lastFullscreenTrigger=null;
let currentFsTrackId=null,currentFsArtSrc=null,activeFsBackdropLayer='b';
function openFullscreenPlayer(){const d=$('#fullscreen-player');if(!d||d.open)return;lastFullscreenTrigger=document.activeElement;d.showModal();paintFullscreenPlayer();const closeBtn=d.querySelector('[data-act="close-fullscreen"]');if(closeBtn)closeBtn.focus();}
function closeFullscreenPlayer(){const d=$('#fullscreen-player');if(!d||!d.open)return;const fsQueue=$('#fullscreen-queue-drawer');if(fsQueue)fsQueue.hidden=true;d.close();paintPlayer();if(lastFullscreenTrigger&&typeof lastFullscreenTrigger.focus==='function'){try{lastFullscreenTrigger.focus();}catch{}}}
function toggleFullscreenQueue(){const q=$('#fullscreen-queue-drawer');if(!q)return;q.hidden=!q.hidden;if(!q.hidden){renderQueueContent(q);const closeBtn=q.querySelector('[data-act="close-fullscreen-queue"]');if(closeBtn)closeBtn.focus();}}
function closeFullscreenQueue(){const q=$('#fullscreen-queue-drawer');if(q)q.hidden=true;}
function paintFullscreenPlayer(){const d=$('#fullscreen-player');if(!d?.open)return;const s=player.current(),p=player.state;if(!s){closeFullscreenPlayer();return;}const details=player.getQueueDetails();const rawContext=(details.currentItem?.contextTitle||'').trim();const rawAlbum=(s.album||'').trim();const isGenericAlbum=!rawAlbum||/^(single|single \/ no album|no album)$/i.test(rawAlbum);const meaningfulAlbum=isGenericAlbum?null:rawAlbum;const contextName=rawContext||meaningfulAlbum||s.artist||"CHIKU'S PLAY";const ctxEl=$('#fullscreen-context-title');if(ctxEl&&ctxEl.textContent!==contextName)ctxEl.textContent=contextName;const titleEl=$('#fullscreen-title');if(titleEl&&titleEl.textContent!==s.title)titleEl.textContent=s.title;const artistEl=$('#fullscreen-artist');if(artistEl&&artistEl.textContent!==s.artist){artistEl.textContent=s.artist;const aObj=artists.find(a=>a.title.toLowerCase()===s.artist.toLowerCase())||artists.find(a=>a.id===s.artistId);if(aObj){artistEl.setAttribute('data-nav',aObj.id);artistEl.setAttribute('href',`#${aObj.id}`);}else{artistEl.removeAttribute('data-nav');artistEl.removeAttribute('href');}}const albumEl=$('#fullscreen-album');if(albumEl&&albumEl.textContent!==(s.album||''))albumEl.textContent=s.album||'';const artSrc=s.artURL||(s.art?`assets/images/${s.art}.jpg`:'');if(currentFsTrackId!==s.id||currentFsArtSrc!==artSrc){currentFsTrackId=s.id;currentFsArtSrc=artSrc;const artWrap=$('#fullscreen-art');if(artWrap)artWrap.innerHTML=art(s);const backdrop=$('#fullscreen-backdrop');if(backdrop){if(artSrc){backdrop.style.backgroundImage=`url('${artSrc}')`;backdrop.style.backgroundColor=s.color||'#161d15';}else{backdrop.style.backgroundImage='none';backdrop.style.backgroundColor=s.color||'#161d15';}}const layerA=$('#backdrop-layer-a'),layerB=$('#backdrop-layer-b');if(layerA&&layerB){const nextLayer=activeFsBackdropLayer==='a'?layerB:layerA;const currentLayer=activeFsBackdropLayer==='a'?layerA:layerB;if(artSrc){nextLayer.style.backgroundImage=`url('${artSrc}')`;nextLayer.style.backgroundColor=s.color||'#161d15';}else{nextLayer.style.backgroundImage='none';nextLayer.style.backgroundColor=s.color||'#161d15';}nextLayer.classList.add('is-active');currentLayer.classList.remove('is-active');activeFsBackdropLayer=activeFsBackdropLayer==='a'?'b':'a';}}const artContainer=$('#fullscreen-art-wrap');if(artContainer){artContainer.classList.toggle('is-playing',Boolean(p.playing));artContainer.classList.toggle('mode-cover',fsArtMode==='cover');}const glowEl=d.querySelector('.visualizer-ambient-glow');if(glowEl&&s.color){glowEl.style.background=`radial-gradient(circle, ${s.color} 0%, rgba(0,210,255,0.18) 45%, transparent 70%)`;}const elapsedEl=$('#fullscreen-elapsed');if(elapsedEl)elapsedEl.textContent=fmt(p.time);const durEl=$('#fullscreen-duration');if(durEl)durEl.textContent=fmt(s.duration);const timeEl=$('#fullscreen-time');if(timeEl){timeEl.max=s.duration;timeEl.value=p.time;timeEl.setAttribute('aria-valuenow',p.time);timeEl.setAttribute('aria-valuemin',0);timeEl.setAttribute('aria-valuemax',s.duration);const m=Math.floor(p.time/60),sec=Math.floor(p.time%60);const durM=Math.floor(s.duration/60),durSec=Math.floor(s.duration%60);timeEl.setAttribute('aria-valuetext',`${m} minute${m===1?'':'s'}, ${sec} second${sec===1?'':'s'} of ${durM} minute${durM===1?'':'s'}, ${durSec} second${durSec===1?'':'s'}`);timeEl.style.setProperty('--pct',`${(100*(p.time||0))/(s.duration||1)}%`);}const volEl=$('#fullscreen-volume');if(volEl){const volVal=p.muted?0:p.volume;volEl.value=volVal;volEl.setAttribute('aria-valuenow',volVal);volEl.setAttribute('aria-valuemin',0);volEl.setAttribute('aria-valuemax',100);volEl.setAttribute('aria-valuetext',p.muted?'Muted, 0 percent':`${volVal} percent`);volEl.style.setProperty('--pct',`${volVal}%`);}const setBtn=(sel,lbl,ico,prs)=>{const el=$(`#fullscreen-player ${sel}`);if(!el)return;el.setAttribute('aria-label',lbl);el.title=lbl;if(ico)el.innerHTML=icon(ico);if(prs!==undefined)el.setAttribute('aria-pressed',prs);};setBtn('[data-act="play"]',p.playing?'Pause':'Play',p.playing?'pause':'play');setBtn('[data-act="muted"]',p.muted?'Unmute':'Mute',p.muted?'muted':'volume',p.muted);setBtn('[data-act="shuffle"]','Shuffle',null,p.shuffle);setBtn('[data-act="repeat"]','Repeat',null,p.repeat);setBtn('[data-act="player-like"]',library.likes.includes(s.id)?'Unlike song':'Like song','heart',library.likes.includes(s.id));const speedLabel=$('#fullscreen-speed-label');if(speedLabel)speedLabel.textContent=`${p.playbackRate||1}x`;const sleepBtn=$('#fullscreen-player [data-act="open-sleep-timer"]');if(sleepBtn){if(p.sleepDeadline){const remSec=Math.max(0,Math.round((p.sleepDeadline-Date.now())/1000));const remMin=Math.ceil(remSec/60);sleepBtn.classList.add('has-timer');sleepBtn.setAttribute('aria-label',`Sleep timer: ${remMin}m remaining`);sleepBtn.title=`Sleep timer: ${remMin}m remaining`;}else if(p.sleepEndOfTrack){sleepBtn.classList.add('has-timer');sleepBtn.setAttribute('aria-label','Sleep timer: End of track');sleepBtn.title='Sleep timer: End of track';}else{sleepBtn.classList.remove('has-timer');sleepBtn.setAttribute('aria-label','Sleep timer');sleepBtn.title='Sleep timer';}}const fsQueue=$('#fullscreen-queue-drawer');if(fsQueue&&!fsQueue.hidden)renderQueueContent(fsQueue);}
let lastSleepTrigger=null;
function openSleepTimerDialog(){const d=$('#sleep-timer-dialog');if(!d)return;lastSleepTrigger=document.activeElement;const statusEl=$('#sleep-timer-status');const p=player.state;if(p.sleepDeadline){const remSec=Math.max(0,Math.round((p.sleepDeadline-Date.now())/1000));const remMin=Math.ceil(remSec/60);if(statusEl)statusEl.textContent=`Active: ~${remMin} minute${remMin===1?'':'s'} remaining`;}else if(p.sleepEndOfTrack){if(statusEl)statusEl.textContent='Active: stopping at end of current song';}else{if(statusEl)statusEl.textContent='No sleep timer active';}d.querySelectorAll('.sleep-option').forEach(btn=>{const min=btn.dataset.minutes;if(!min)return;if(p.sleepEndOfTrack&&min==='end'){btn.classList.add('selected');btn.setAttribute('aria-checked','true');}else if(p.sleepDeadline&&min!=='end'){const remSec=Math.max(0,Math.round((p.sleepDeadline-Date.now())/1000));const remMin=Math.round(remSec/60);const matches=Math.abs(remMin-Number(min))<=1;btn.classList.toggle('selected',matches);btn.setAttribute('aria-checked',String(matches));}else{btn.classList.remove('selected');btn.setAttribute('aria-checked','false');}});d.showModal();}
function closeSleepTimerDialog(){const d=$('#sleep-timer-dialog');if(d?.open)d.close();if(lastSleepTrigger&&typeof lastSleepTrigger.focus==='function'){try{lastSleepTrigger.focus();}catch{}}}
let lastSpeedTrigger=null;
function openSpeedDialog(){const d=$('#speed-dialog');if(!d)return;lastSpeedTrigger=document.activeElement;const msgEl=$('#speed-status-msg');const isSupported=player.state.playbackRateSupported!==false;if(msgEl){msgEl.textContent=isSupported?'':'Custom playback speed is not supported by your browser.';msgEl.className=isSupported?'dialog-message':'dialog-message error';}const curRate=player.state.playbackRate||1.0;d.querySelectorAll('.speed-option').forEach(btn=>{const rate=Number(btn.dataset.rate);const isCurrent=Math.abs(rate-curRate)<0.05;btn.classList.toggle('selected',isCurrent);btn.setAttribute('aria-checked',String(isCurrent));btn.disabled=!isSupported;});d.showModal();}
function closeSpeedDialog(){const d=$('#speed-dialog');if(d?.open)d.close();if(lastSpeedTrigger&&typeof lastSpeedTrigger.focus==='function'){try{lastSpeedTrigger.focus();}catch{}}}
function closeAllPlaybackDialogs(){
  try{$('#fullscreen-player')?.close();}catch{}
  try{const q=$('#queue');if(q)q.hidden=true;}catch{}
  try{const fsQ=$('#fullscreen-queue-drawer');if(fsQ)fsQ.hidden=true;}catch{}
  try{$('#sleep-timer-dialog')?.close();}catch{}
  try{$('#speed-dialog')?.close();}catch{}
  try{$('#profile-dialog')?.close();}catch{}
  try{$('#playlist-dialog')?.close();}catch{}
  try{$('#playlist-tracks-dialog')?.close();}catch{}
}
const go=navigation(render);sidebar();paintPlayer();accountUI();
function triggerLikeAnimation(id){
  document.querySelectorAll(`[data-act="like"][data-id="${id}"]`).forEach(btn=>{
    btn.classList.remove('like-pop');
    void btn.offsetWidth;
    btn.classList.add('like-pop');
    btn.addEventListener('animationend',()=>btn.classList.remove('like-pop'),{once:true});
  });
  const currentSong=player.current();
  if(currentSong&&String(currentSong.id)===String(id)){
    document.querySelectorAll('[data-act="player-like"]').forEach(btn=>{
      btn.classList.remove('like-pop');
      void btn.offsetWidth;
      btn.classList.add('like-pop');
      btn.addEventListener('animationend',()=>btn.classList.remove('like-pop'),{once:true});
    });
  }
}
async function like(id){if(!account())return;const next=!library.likes.includes(id);try{if(demo){library.likes=next?[id,...library.likes]:library.likes.filter(x=>x!==id);save('likes',library.likes);}else{await setLike(id,next,session?.user?.id);await refreshLibrary(false);}paintPlayer();render(page);toast(next?'Added to Liked Songs':'Removed from Liked Songs');if(next){triggerLikeAnimation(id);}}catch(e){toast(`Could not update likes: ${e.message}`);}}
function openPlaylist(p){if(!account())return;const f=$('#playlist-form');f.reset();f.elements.id.value=p?.id||'';f.elements.name.value=p?.title||'';f.elements.description.value=p?.description||'';if(f.elements.isPublic)f.elements.isPublic.checked=Boolean(p?.isPublic);$('#playlist-dialog-title').textContent=p?'Edit playlist':'Create playlist';f.querySelector('.dialog-message').textContent='';$('#playlist-dialog').showModal();}
function openTracks(pid,selected=[]){if(!account())return;const p=find(pid),f=$('#playlist-tracks-form');f.reset();f.elements.playlistId.value=pid;f.elements.tracks.innerHTML=songs.filter(s=>!p.tracks.includes(s.id)).map(s=>`<option value="${s.id}" ${selected.includes(s.id)?'selected':''}>${safe(s.title)} · ${safe(s.artist)}</option>`).join('');f.querySelector('.dialog-message').textContent='';$('#playlist-tracks-dialog').showModal();}
async function openEditProfileDialog(){
  if(!session?.user){toast('Sign in to edit your profile.');return;}
  const dialog=$('#profile-dialog');
  if(!dialog)return;
  const f=$('#profile-form');
  f.reset();
  avatarFileToUpload=null;
  if(avatarPreviewBlobUrl){URL.revokeObjectURL(avatarPreviewBlobUrl);avatarPreviewBlobUrl=null;}
  const nameInput=$('#profile-display-name'),userInput=$('#profile-username'),bioInput=$('#profile-bio');
  const bioCounter=$('#profile-bio-count'),statusEl=$('#profile-username-status'),msgEl=$('#profile-dialog-message'),previewEl=$('#profile-avatar-preview'),saveBtn=$('#profile-save-btn');
  if(!currentProfile){try{currentProfile=await getProfile(session.user.id);}catch{}}
  const curName=displayNameFor(session.user,currentProfile);
  nameInput.value=curName||'';
  userInput.value=currentProfile?.username||'';
  bioInput.value=currentProfile?.bio||'';
  bioCounter.textContent=bioInput.value.length;
  statusEl.className='username-status';
  statusEl.textContent=currentProfile?.username?'✓ Current':'';
  isUsernameAvailable=Boolean(currentProfile?.username);
  msgEl.className='dialog-message';
  msgEl.textContent='';
  saveBtn.disabled=false;
  saveBtn.textContent='Save changes';
  const avatarFallback=currentProfile?.avatar_url||session.user.user_metadata?.avatar_url;
  getAvatarUrl(currentProfile?.avatar_path,avatarFallback).then(src=>{
    if(previewEl)previewEl.innerHTML=src?`<img src="${safe(src)}" alt="">`:safe((curName[0]||'A').toUpperCase());
  }).catch(()=>{
    if(previewEl)previewEl.innerHTML=safe((curName[0]||'A').toUpperCase());
  });
  const pDetails=$('#profile');
  if(pDetails)pDetails.open=false;
  dialog.showModal();
}
function closeEditProfileDialog(){
  const dialog=$('#profile-dialog');
  if(dialog?.open)dialog.close();
  avatarFileToUpload=null;
  if(avatarPreviewBlobUrl){URL.revokeObjectURL(avatarPreviewBlobUrl);avatarPreviewBlobUrl=null;}
}
function handleUsernameInput(e){
  const statusEl=$('#profile-username-status');
  if(!statusEl)return;
  clearTimeout(usernameCheckTimer);
  const clean=e.target.value.trim().toLowerCase();
  if(!clean){
    statusEl.className='username-status invalid';
    statusEl.textContent='Required';
    isUsernameAvailable=false;
    return;
  }
  if(!/^[a-z0-9_]{3,30}$/.test(clean)){
    statusEl.className='username-status invalid';
    statusEl.textContent=clean.length<3?'Too short':clean.length>30?'Too long':'Letters, numbers, _ only';
    isUsernameAvailable=false;
    return;
  }
  if(currentProfile?.username&&clean===currentProfile.username.toLowerCase()){
    statusEl.className='username-status valid';
    statusEl.textContent='✓ Current';
    isUsernameAvailable=true;
    return;
  }
  statusEl.className='username-status checking';
  statusEl.textContent='Checking…';
  isUsernameAvailable=false;
  usernameCheckTimer=setTimeout(async()=>{
    if(demo){
      if($('#profile-username')?.value?.trim()?.toLowerCase()!==clean)return;
      const taken=['admin','soundify','spotify'];
      if(taken.includes(clean)){
        statusEl.className='username-status invalid';
        statusEl.textContent='Taken';
        isUsernameAvailable=false;
      }else{
        statusEl.className='username-status valid';
        statusEl.textContent='✓ Available';
        isUsernameAvailable=true;
      }
      return;
    }
    try{
      const res=await checkUsernameAvailability(clean,session?.user?.id);
      if($('#profile-username')?.value?.trim()?.toLowerCase()!==clean)return;
      if(res.available){
        statusEl.className='username-status valid';
        statusEl.textContent='✓ Available';
        isUsernameAvailable=true;
      }else{
        statusEl.className='username-status invalid';
        statusEl.textContent='Taken';
        isUsernameAvailable=false;
      }
    }catch{
      if($('#profile-username')?.value?.trim()?.toLowerCase()!==clean)return;
      statusEl.className='username-status invalid';
      statusEl.textContent='Error checking';
      isUsernameAvailable=false;
    }
  },350);
}
function handleAvatarChange(e){
  const file=e.target.files?.[0],msgEl=$('#profile-dialog-message'),previewEl=$('#profile-avatar-preview');
  if(!file)return;
  try{
    validateAvatar(file);
    avatarFileToUpload=file;
    if(avatarPreviewBlobUrl)URL.revokeObjectURL(avatarPreviewBlobUrl);
    avatarPreviewBlobUrl=URL.createObjectURL(file);
    if(previewEl)previewEl.innerHTML=`<img src="${avatarPreviewBlobUrl}" alt="Avatar preview">`;
    if(msgEl){msgEl.className='dialog-message';msgEl.textContent='';}
  }catch(err){
    avatarFileToUpload=null;
    e.target.value='';
    if(msgEl){msgEl.className='dialog-message error';msgEl.textContent=err.message||'Invalid image file.';}
  }
}
async function handleProfileSubmit(e){
  e.preventDefault();
  if(isSubmittingProfile) return;
  if(!session?.user){toast('Sign in to edit your profile.');return;}
  const f=e.currentTarget,msgEl=$('#profile-dialog-message'),saveBtn=$('#profile-save-btn');
  const displayName=f.elements.displayName.value.trim(),username=f.elements.username.value.trim().toLowerCase(),bio=f.elements.bio.value.trim();
  if(!displayName){msgEl.className='dialog-message error';msgEl.textContent='Display name is required.';return;}
  if(!username){msgEl.className='dialog-message error';msgEl.textContent='Username is required.';return;}
  if(!/^[a-z0-9_]{3,30}$/.test(username)){
    msgEl.className='dialog-message error';
    msgEl.textContent='Username must be 3–30 characters and contain only lowercase letters, numbers, and underscores.';
    return;
  }
  if(currentProfile?.username?.toLowerCase()!==username&&!isUsernameAvailable){
    msgEl.className='dialog-message error';
    msgEl.textContent='Please choose an available username.';
    return;
  }
  if(bio.length>300){
    msgEl.className='dialog-message error';
    msgEl.textContent='Bio must not exceed 300 characters.';
    return;
  }

  isSubmittingProfile=true;
  saveBtn.disabled=true;
  saveBtn.textContent='Saving…';
  msgEl.className='dialog-message';
  msgEl.textContent='Saving profile…';

  if(demo){
    if(avatarFileToUpload&&avatarPreviewBlobUrl){
      currentProfile.avatar_url=avatarPreviewBlobUrl;
      currentProfile.avatar_path=null;
    }
    currentProfile.display_name=displayName;
    currentProfile.username=username;
    currentProfile.bio=bio;
    closeEditProfileDialog();
    await accountUI();
    if(page==='settings'||page.startsWith('profile/')||page.startsWith('@'))render(page);
    toast('Profile updated successfully.');
    saveBtn.disabled=false;
    saveBtn.textContent='Save changes';
    isSubmittingProfile=false;
    return;
  }

  let uploadedAvatar=null;
  try{
    if(avatarFileToUpload){
      msgEl.textContent='Uploading avatar…';
      uploadedAvatar=await uploadAvatar(avatarFileToUpload,session.user.id);
    }
    msgEl.textContent='Updating profile…';
    const payload={displayName,username,bio,userId:session.user.id};
    if(uploadedAvatar){payload.avatarPath=uploadedAvatar.avatarPath;payload.avatarUrl=uploadedAvatar.publicUrl;}
    const updated=await updateProfile(payload);
    currentProfile=updated;
    closeEditProfileDialog();
    await accountUI();
    if(page==='settings'||page.startsWith('profile/')||page.startsWith('@'))render(page);
    toast('Profile updated successfully.');
  }catch(err){
    console.error('Profile update error:',err);
    const isTimeout=err.name==='AbortError'||err.message?.includes('timed out')||err.message?.includes('aborted');
    if(uploadedAvatar?.avatarPath&&!isTimeout){
      try{
        const db=await getSupabase();
        await db.storage.from('avatars').remove([uploadedAvatar.avatarPath]);
      }catch(cleanErr){console.warn('Could not clean up uploaded avatar:',cleanErr);}
    }else if(uploadedAvatar?.avatarPath&&isTimeout){
      try{
        const db=await getSupabase();
        const {data:latest}=await db.from('profiles').select('avatar_path').eq('id',session.user.id).maybeSingle();
        if(latest&&latest.avatar_path!==uploadedAvatar.avatarPath){
          await db.storage.from('avatars').remove([uploadedAvatar.avatarPath]);
        }
      }catch(checkErr){console.warn('Could not verify profile state after timeout:',checkErr);}
    }
    msgEl.className='dialog-message error';
    msgEl.textContent=err.message||'Could not save profile.';
  }finally{
    saveBtn.disabled=false;
    saveBtn.textContent='Save changes';
    isSubmittingProfile=false;
  }
}
document.addEventListener('click',async e=>{const profile=$('#profile');if(profile?.open&&(!profile.contains(e.target)||e.target.closest('.profile-menu [data-nav],.profile-menu [data-act]')))profile.open=false;const actionsEl=e.target.closest('.track-actions');const el=e.target.closest('[data-nav],[data-act],[data-play]');if(!el){const playerPill=e.target.closest('#player');if(playerPill&&!e.target.closest('button,a,input,summary,[data-act],[data-nav],[data-play]')){openFullscreenPlayer();}return;}if(page==='search'&&query.trim()&&e.target.closest('#results [data-nav],#results [data-play],#results [data-act="play-list"]'))addSearchHistory(query);if(actionsEl&&!el.dataset.act)return;const {nav,act,id,play}=el.dataset;if(nav){if($('#fullscreen-player')?.open)closeFullscreenPlayer();e.preventDefault();go(nav);return;}if(act==='play-list'){const p=allPlaylists().find(x=>x.id===id)||find(id);if(p?.tracks?.length)player.select(p.tracks[0],p.tracks,p.title||'Playlist');return;}if(play){let q=null,contextTitle='';if(page==='search'){contextTitle=query.trim()?`Search: "${query.trim()}"`:'Search';const words=query.trim().toLowerCase().split(/\s+/).filter(Boolean);if(words.length){const matches=catalog().filter(x=>words.every(w=>[x.title,x.artist,x.album,x.description,x.genre].filter(Boolean).join(' ').toLowerCase().includes(w)));const songMatches=matches.filter(x=>x.type==='song').map(s=>s.id);if(songMatches.includes(play))q=songMatches;}}else{const shelf=el.closest('.shelf'),shelfTitle=shelf?.querySelector?.('.section-head h2')?.textContent?.trim();if(shelfTitle==='Recently Played'||page==='recent'){contextTitle='Recently Played';if(library.recent.includes(play))q=library.recent;}else if(page==='liked'){contextTitle='Liked Songs';if(library.likes.includes(play))q=library.likes;}else if(page==='discover'||page==='home'){contextTitle=shelfTitle||'';const shelfTracks=Array.from(shelf?.querySelectorAll?.('[data-play]')||[]).map(b=>b.dataset.play).filter(Boolean);const uniqueTracks=[...new Set(shelfTracks)];if(uniqueTracks.includes(play))q=uniqueTracks;}else{const x=find(page);if(x?.title)contextTitle=x.title;if(x?.tracks?.includes?.(play))q=x.tracks;}}player.select(play,q||songs.map(s=>s.id),contextTitle);return;}if(act==='home-filter'){homeCategory=el.dataset.filter||'All';render('home');return;}if(act==='set-accent'){const acc=el.dataset.accent;if(acc){applyAccent(acc);toast(`Accent set to ${acc.charAt(0).toUpperCase()+acc.slice(1)}`);if(page==='settings')renderSettings();}return;}if(act==='toggle-fs-art-mode'){const nextMode=fsArtMode==='cover'?'vinyl':'cover';applyFsArtMode(nextMode);toast(nextMode==='cover'?'Cover view enabled':'Vinyl view enabled');return;}if(act==='share-track'){const s=player.current();if(!s)return;const shareData={title:`${s.title} • CHIKU'S PLAY`,text:`Listen to ${s.title} by ${s.artist} on CHIKU'S PLAY`,url:window.location.origin+window.location.pathname+`#song/${s.id}`};if(navigator.share){navigator.share(shareData).catch(()=>{});}else if(navigator.clipboard){navigator.clipboard.writeText(shareData.url).then(()=>{toast('Track link copied to clipboard');}).catch(()=>{toast('Could not copy link');});}else{toast('Sharing not supported on this browser');}return;}if(act==='open-fullscreen')return openFullscreenPlayer();if(act==='close-fullscreen')return closeFullscreenPlayer();if(act==='toggle-fullscreen-queue')return toggleFullscreenQueue();if(act==='close-fullscreen-queue')return closeFullscreenQueue();if(act==='toggle-queue'){if($('#fullscreen-player')?.open)return toggleFullscreenQueue();return toggleQueueDrawer();}if(act==='close-queue')return closeQueueDrawer();if(act==='clear-upcoming'){player.clearUpcoming();paintQueue();toast('Upcoming queue cleared');return;}if(act==='remove-queue-item'){player.removeFromQueue(el.dataset.uid);paintQueue();toast('Removed from queue');return;}if(act==='select-queue-item'){player.selectQueueItem(el.dataset.uid);paintQueue();return;}if(act==='play-next'){player.playNext(id);paintQueue();toast('Playing next');return;}if(act==='add-to-queue'){player.addToQueue(id);paintQueue();toast('Added to queue');return;}if(act==='open-sleep-timer')return openSleepTimerDialog();if(act==='close-sleep-timer')return closeSleepTimerDialog();if(act==='set-sleep'){const min=el.dataset.minutes;if(min==='end'){player.setSleepTimer(0,true);toast('Sleep timer: End of current song');}else{const m=Number(min);player.setSleepTimer(m);toast(`Sleep timer set for ${m} minutes`);}closeSleepTimerDialog();return;}if(act==='cancel-sleep'){player.clearSleepTimer();toast('Sleep timer turned off');closeSleepTimerDialog();return;}if(act==='open-speed')return openSpeedDialog();if(act==='close-speed-dialog')return closeSpeedDialog();if(act==='set-speed'){const rate=Number(el.dataset.rate);player.setPlaybackRate(rate);toast(`Speed set to ${rate}x`);closeSpeedDialog();return;}if(['back','forward'].includes(act))return go(act);if(['play','prev','next','shuffle','repeat','muted'].includes(act))return player.act(act);if(act==='player-like')return like(player.state.id);if(act==='like')return like(id);if(act==='clear-search'){query='';const input=$('#search-input');if(input){input.value='';input.focus();}search();return;}if(act==='apply-search'){query=el.dataset.query||'';const input=$('#search-input');if(input){input.value=query;input.focus();}search();return;}if(act==='clear-recent-searches'){clearSearchHistory();search();return;}if(act==='discover-genre'){query=el.dataset.genre||'';searchType='All';go('search');return;}if(act==='create-playlist')return openPlaylist();if(act==='edit-playlist')return openPlaylist(find(id));if(act==='add-tracks')return openTracks(id);if(act==='add-track'){if(!account())return;if(!library.playlists.length){openPlaylist();toast('Create a playlist first, then add this track.');}else openTracks(library.playlists[0].id,[id]);return;}if(act==='remove-track'){try{const p=find(el.dataset.playlistId);if(demo){p.tracks=p.tracks.filter(trackId=>trackId!==id);save('playlists',library.playlists);}else await removeTrack(el.dataset.playlistId,id);await refreshLibrary();toast('Track removed from playlist');}catch(err){toast(`Could not remove track: ${err.message}`);}return;}if(act==='delete-playlist'){const p=find(id);if(!p||!confirm(`Delete “${p.title}”? This cannot be undone.`))return;try{if(demo){library.playlists=library.playlists.filter(item=>item.id!==id);save('playlists',library.playlists);}else await deletePlaylist(id,p.coverPath);await refreshLibrary(false);sidebar();go('library');toast('Playlist deleted');}catch(err){toast(`Could not delete playlist: ${err.message}`);}return;}if(act==='cancel-playlist')return $('#playlist-dialog').close();if(act==='cancel-tracks')return $('#playlist-tracks-dialog').close();if(act==='open-edit-profile')return openEditProfileDialog();if(act==='cancel-profile')return closeEditProfileDialog();if(act==='view-all-songs'){searchType='Songs';search();return;}if(act==='search-filter'){searchType=id;search();return;}if(act==='library-filter'){libraryType=id;paintLibrary();return;}if(act==='follow-artist'){if(!account())return;const artistId=id;if(followLocks.has(artistId))return;followLocks.add(artistId);const currentlyFollowing=(library.following||[]).includes(artistId);const next=!currentlyFollowing;const artistObj=find(artistId);const artistTitle=artistObj?.title||'artist';if(next){library.following=[...(library.following||[]),artistId];}else{library.following=(library.following||[]).filter(a=>a!==artistId);}const curCount=followerCountsCache.get(artistId);if(curCount!==null&&curCount!==undefined){followerCountsCache.set(artistId,next?curCount+1:Math.max(0,curCount-1));}const btn=el.closest('[data-act="follow-artist"]')||el;btn.setAttribute('aria-pressed',String(next));btn.setAttribute('aria-label',next?`Unfollow ${safe(artistTitle)}`:`Follow ${safe(artistTitle)}`);btn.innerHTML=`${icon(next?'user':'plus')} ${next?'Following':'Follow'}`;const countEl=$('#artist-follower-count');if(countEl&&curCount!==null&&curCount!==undefined){countEl.innerHTML=formatFollowers(followerCountsCache.get(artistId));}try{if(demo){save('following',library.following);}else{await setFollowArtist(artistId,next,session.user.id);await refreshLibrary(false);try{const refreshedCount=await getArtistFollowerCount(artistId);followerCountsCache.set(artistId,refreshedCount);if(countEl)countEl.innerHTML=formatFollowers(refreshedCount);}catch(cntErr){console.warn('Count refresh error:',cntErr);}}toast(next?`Following ${artistTitle}`:`Unfollowed ${artistTitle}`);if(page==='discover'||page==='library')render(page);}catch(err){console.error('Follow error:',err);if(next){library.following=(library.following||[]).filter(a=>a!==artistId);}else{library.following=[...(library.following||[]),artistId];}followerCountsCache.set(artistId,curCount);btn.setAttribute('aria-pressed',String(!next));btn.setAttribute('aria-label',!next?`Unfollow ${safe(artistTitle)}`:`Follow ${safe(artistTitle)}`);btn.innerHTML=`${icon(!next?'user':'plus')} ${!next?'Following':'Follow'}`;if(countEl)countEl.innerHTML=formatFollowers(curCount);toast(`Could not update follow: ${err.message}`);}finally{followLocks.delete(artistId);}return;}if(act==='sign-out'){
  player.pausePlayback();
  let globalSignOutError=null;
  try{
    await signOut();
  }catch(err){
    globalSignOutError=err;
    console.warn('Global signOut network request failed:',err);
  }
  let localSession=null;
  let sessionCheckFailed=false;
  try{
    localSession=await getSession();
  }catch(checkErr){
    sessionCheckFailed=true;
    console.warn('Local session inspection error:',checkErr);
  }
  if(!sessionCheckFailed && localSession?.user){
    toast('Sign out failed: Network error. You are still signed in.');
    return;
  }
  if(!sessionCheckFailed && !localSession){
    player.resetPlayerForAccountSwitch();
    closeAllPlaybackDialogs();
    library={likes:[],playlists:[],recent:[],following:[]};
    currentProfile=null;
    invalidateDiscoveryCache();
    publicPlaylistsCache.clear();
    followerCountsCache.clear();
    followLocks.clear();
    try{
      localStorage.removeItem(`soundify-${location.host}-likes`);
      localStorage.removeItem(`soundify-${location.host}-recent`);
    }catch{}
    if(typeof location.replace==='function'){location.replace('login.html');}else{location.href='login.html';}
    return;
  }
  if(sessionCheckFailed){
    toast('Sign out could not be verified. You remain signed in.');
    return;
  }
}});
document.addEventListener('input',e=>{if(e.target.id==='search-input'){query=e.target.value;const clearBtn=$('.search-clear');if(clearBtn)clearBtn.hidden=!query.trim();search();}if(e.target.id==='profile-username')handleUsernameInput(e);if(e.target.id==='profile-bio'){const c=$('#profile-bio-count');if(c)c.textContent=e.target.value.length;}if(['time','volume','fullscreen-time','fullscreen-volume'].includes(e.target.id))player.act(e.target.id.replace('fullscreen-',''),e.target.value);});document.addEventListener('change',e=>{if(e.target.id==='profile-avatar-input')handleAvatarChange(e);if(e.target.id==='pref-theme'||e.target.dataset.act==='change-pref-theme'){applyTheme(e.target.value);toast(`Theme set to ${e.target.options[e.target.selectedIndex].text}`);}if(e.target.dataset.pref==='normalize'){localStorage.setItem('soundify-pref-normalize',e.target.checked);toast(e.target.checked?'Volume normalization enabled':'Volume normalization disabled');}if(e.target.dataset.pref==='autoplay'){localStorage.setItem('soundify-pref-autoplay',e.target.checked);toast(e.target.checked?'Autoplay enabled':'Autoplay disabled');}if(e.target.id==='pref-quality'){localStorage.setItem('soundify-pref-quality',e.target.value);toast(`Audio quality set to ${e.target.value.toUpperCase()}`);}if(e.target.id==='pref-crossfade'||e.target.dataset.act==='change-pref-crossfade'){const val=parseInt(e.target.value,10)||0;const setVal=typeof player.setCrossfade==='function'?player.setCrossfade(val):val;localStorage.setItem('soundify-pref-crossfade',String(setVal));toast(setVal>0?`Crossfade set to ${setVal} seconds`:'Crossfade turned off');}});document.addEventListener('keydown',e=>{
  if(e.key==='Enter'&&e.target.id==='search-input'&&query.trim()){addSearchHistory(query);return;}
  const target=e.target,tag=target?.tagName?.toLowerCase();
  const isField=tag==='input'||tag==='textarea'||tag==='select'||target?.isContentEditable;
  if(e.key==='Escape'){
    const speedDialog=$('#speed-dialog');
    const sleepDialog=$('#sleep-timer-dialog');
    if(speedDialog?.open||sleepDialog?.open)return;
    const fsDialog=$('#fullscreen-player');
    if(fsDialog?.open){
      const fsQueue=$('#fullscreen-queue-drawer');
      if(fsQueue&&!fsQueue.hidden){e.preventDefault();fsQueue.hidden=true;return;}
      e.preventDefault();
      closeFullscreenPlayer();
      return;
    }
    const qEl=$('#queue');
    if(qEl&&!qEl.hidden){e.preventDefault();closeQueueDrawer();return;}
    return;
  }
  if(isField||e.isComposing||e.ctrlKey||e.altKey||e.metaKey||e.repeat)return;
  const isInteractive=tag==='button'||tag==='a'||tag==='summary'||target?.getAttribute?.('role')==='button'||target?.getAttribute?.('role')==='link'||target?.getAttribute?.('role')==='slider';
  if(isInteractive)return;
  const speedDialog=$('#speed-dialog');
  const sleepDialog=$('#sleep-timer-dialog');
  const fsDialog=$('#fullscreen-player');
  if(speedDialog?.open||sleepDialog?.open)return;
  if(e.key==='f'||e.key==='F'){
    e.preventDefault();
    if(fsDialog?.open)closeFullscreenPlayer();
    else openFullscreenPlayer();
    return;
  }
  if(document.querySelector('dialog[open]')&&(!fsDialog?.open||document.querySelector('dialog[open]:not(#fullscreen-player)')))return;
  if(e.code==='Space'||e.key===' '){
    e.preventDefault();
    player.act('play');
    return;
  }
  if(e.shiftKey&&(e.key==='ArrowLeft'||e.key==='Left')){
    e.preventDefault();
    player.act('prev');
    return;
  }
  if(e.shiftKey&&(e.key==='ArrowRight'||e.key==='Right')){
    e.preventDefault();
    player.act('next');
    return;
  }
  if(!e.shiftKey&&(e.key==='ArrowLeft'||e.key==='Left')){
    e.preventDefault();
    const curTime=player.state.time||0;
    player.act('time',Math.max(0,curTime-5));
    return;
  }
  if(!e.shiftKey&&(e.key==='ArrowRight'||e.key==='Right')){
    e.preventDefault();
    const curTime=player.state.time||0,dur=player.current()?.duration||0;
    player.act('time',Math.min(dur,curTime+5));
    return;
  }
  if(e.key==='ArrowUp'||e.key==='Up'){
    e.preventDefault();
    const curVol=player.state.volume||0;
    player.act('volume',Math.min(100,curVol+5));
    return;
  }
  if(e.key==='ArrowDown'||e.key==='Down'){
    e.preventDefault();
    const curVol=player.state.volume||0;
    player.act('volume',Math.max(0,curVol-5));
    return;
  }
  if(e.key==='m'||e.key==='M'){
    e.preventDefault();
    player.act('muted');
    return;
  }
  if(e.key==='l'||e.key==='L'){
    e.preventDefault();
    if(player.state.id)like(player.state.id);
    return;
  }
  if(e.key==='q'||e.key==='Q'){
    e.preventDefault();
    toggleQueueDrawer();
    return;
  }
});
document.addEventListener('error',e=>{if(e.target.matches?.('.art img'))e.target.hidden=true;},true);
$('#profile-dialog')?.addEventListener('close',closeEditProfileDialog);
$('#sleep-timer-dialog')?.addEventListener('close',closeSleepTimerDialog);
$('#speed-dialog')?.addEventListener('close',closeSpeedDialog);
$('#fullscreen-player')?.addEventListener('close',closeFullscreenPlayer);
$('#profile-form')?.addEventListener('submit',handleProfileSubmit);
$('#playlist-form').addEventListener('submit',async e=>{e.preventDefault();if(!account())return;const f=e.currentTarget,m=f.querySelector('.dialog-message'),title=f.elements.name.value.trim();if(!title)return;m.textContent='Saving playlist…';const old=find(f.elements.id.value);const isPublic=Boolean(f.elements.isPublic?.checked);const prevKey=f.elements.id.value?(f.elements.id.value.startsWith('playlist-')?f.elements.id.value:`playlist-${f.elements.id.value}`):null;try{const id=demo?(old?.id||`custom-${Date.now()}`):await savePlaylist({id:f.elements.id.value,title,description:f.elements.description.value.trim(),file:f.elements.cover.files?.[0],userId:session.user.id,existingCoverPath:old?.coverPath,isPublic});const finalKey=demo?id:`playlist-${id}`;if(demo){if(old)Object.assign(old,{title,description:f.elements.description.value.trim(),isPublic});else library.playlists.push({id,type:'playlist',personal:true,isPublic,title,description:f.elements.description.value.trim(),tracks:[],color:'#4d3a54'});save('playlists',library.playlists);}else await refreshLibrary(false);if(!isPublic){if(prevKey)publicPlaylistsCache.delete(prevKey);publicPlaylistsCache.delete(finalKey);}else{const saved=find(finalKey)||library.playlists.find(p=>p.id===finalKey);if(saved)publicPlaylistsCache.set(finalKey,{...saved,personal:false,isPublic:true});}$('#playlist-dialog').close();sidebar();render(page);go(demo?id:`playlist-${id}`);toast(isPublic?'Public playlist saved':'Private playlist saved');}catch(err){m.textContent=err.message||'Could not save playlist.';}});
$('#playlist-tracks-form').addEventListener('submit',async e=>{e.preventDefault();const f=e.currentTarget,p=find(f.elements.playlistId.value),tracks=[...f.elements.tracks.selectedOptions].map(o=>o.value),m=f.querySelector('.dialog-message');if(!tracks.length)return;m.textContent='Adding tracks…';try{if(demo){p.tracks=[...new Set([...p.tracks,...tracks])];save('playlists',library.playlists);}else{await addTracks(p.id,tracks,p.tracks.length);await refreshLibrary(false);}$('#playlist-tracks-dialog').close();render(page);toast('Tracks added to playlist');}catch(err){m.textContent=err.message||'Could not add tracks.';}});
onAuthStateChange(newSession=>{
  const previousUserId=currentAuthUserId;
  const nextUserId=newSession?.user?.id || null;
  currentAuthUserId=nextUserId;
  session=newSession;

  const isIdentityChange=previousUserId!==nextUserId;

  if(isIdentityChange){
    libraryLoadToken++;
    player.resetPlayerForAccountSwitch();
    closeAllPlaybackDialogs();
    library={likes:[],playlists:[],recent:[],following:[]};
    currentProfile=null;
    invalidateDiscoveryCache();
    publicPlaylistsCache.clear();
    followerCountsCache.clear();
    followLocks.clear();
    try{
      localStorage.removeItem(`soundify-${location.host}-likes`);
      localStorage.removeItem(`soundify-${location.host}-recent`);
    }catch{}
    sidebar();
    render(page);
  }

  setTimeout(()=>{
    accountUI().catch(err=>console.warn('Deferred accountUI error:',err));
  },0);
});
