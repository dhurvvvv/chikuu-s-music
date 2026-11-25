import {getSupabase} from './supabase.js';

export async function getSession(){
 const db=await getSupabase();
 const {data,error}=await db.auth.getSession();
 if(error) throw error;
 return data.session;
}

export async function getUser(){
 const session=await getSession();
 return session?.user ?? null;
}

export function onAuthStateChange(callback){
 // Returns unsubscribe function.
 let unsubscribe=()=>{};
 getSupabase().then(db=>{
  const {data}=db.auth.onAuthStateChange((_event,session)=>callback(session));
  unsubscribe=()=>data.subscription.unsubscribe();
 }).catch(err=>callback(null,err));
 return ()=>unsubscribe();
}

export async function signInWithGoogle(){
 const db=await getSupabase();
 const redirectTo=`${location.origin}${location.pathname.replace(/[^/]*$/,'')}index.html`;
 const {error}=await db.auth.signInWithOAuth({
  provider:'google',
  options:{redirectTo}
 });
 if(error) throw error;
}

export async function signInWithPassword(email, password){
 const cleanEmail=String(email??'').trim().toLowerCase();
 const cleanPassword=String(password??'');
 if(!cleanEmail||!cleanPassword){
  throw new Error('Email and password are required.');
 }
 const db=await getSupabase();
 const {data,error}=await db.auth.signInWithPassword({
  email:cleanEmail,
  password:cleanPassword
 });
 if(error) throw error;
 return data;
}

export async function signUp(email, password){
 const cleanEmail=String(email??'').trim().toLowerCase();
 const cleanPassword=String(password??'');
 if(!cleanEmail||!cleanPassword){
  throw new Error('Email and password are required.');
 }
 if(cleanPassword.length<6){
  throw new Error('Password must be at least 6 characters.');
 }
 const db=await getSupabase();
 const redirectTo=`${location.origin}${location.pathname.replace(/[^/]*$/,'')}index.html`;
 const {data,error}=await db.auth.signUp({
  email:cleanEmail,
  password:cleanPassword,
  options:{emailRedirectTo:redirectTo}
 });
 if(error) throw error;
 return data;
}

export async function signOut(){
 const db=await getSupabase();
 const {error}=await db.auth.signOut();
 if(error) throw error;
}

export async function getProfile(userId = null){
 const targetUserId = userId || (await getUser())?.id;
 if(!targetUserId) return null;
 const db=await getSupabase();
 const {data,error}=await db
  .from('profiles')
  .select('id,username,display_name,avatar_url,avatar_path,bio,created_at')
  .eq('id',targetUserId)
  .maybeSingle();
 if(error) throw error;
 return data;
}

export async function updateProfile({displayName, username, bio, avatarUrl, avatarPath, userId} = {}){
 const targetUserId = userId || (await getUser())?.id;
 if(!targetUserId) throw new Error('Authentication is required.');
 const payload={};
 if(displayName!==undefined){
  payload.display_name=String(displayName??'').trim().slice(0,100);
 }
 if(username!==undefined){
  const clean=String(username??'').trim().toLowerCase();
  if(!/^[a-z0-9_]{3,30}$/.test(clean)){
   throw new Error('Username must be 3–30 characters and contain only lowercase letters, numbers, and underscores.');
  }
  payload.username=clean;
 }
 if(bio!==undefined){
  const cleanBio=String(bio??'');
  if(cleanBio.length>300){
   throw new Error('Bio must be 300 characters or fewer.');
  }
  payload.bio=cleanBio;
 }
 if(avatarUrl!==undefined){
  payload.avatar_url=avatarUrl?String(avatarUrl).trim().slice(0,2048):null;
 }
 if(avatarPath!==undefined){
  payload.avatar_path=avatarPath?String(avatarPath).trim():null;
 }
 if(!Object.keys(payload).length){
  return getProfile(targetUserId);
 }
 const db=await getSupabase();
 const controller = new AbortController();
 const timeoutId = setTimeout(() => controller.abort(), 15000);
 try {
  let query = db
   .from('profiles')
   .update(payload)
   .eq('id', targetUserId);
  if(typeof query.abortSignal === 'function'){
   query = query.abortSignal(controller.signal);
  }
  const {data,error}=await query
   .select('id,username,display_name,avatar_url,avatar_path,bio,created_at')
   .single();
  clearTimeout(timeoutId);
  if(error){
   if(error.code==='23505'||error.message?.includes('profiles_username_lower_idx')||error.message?.includes('duplicate key')){
    throw new Error('This username is already taken. Please choose another.');
   }
   throw error;
  }
  return data;
 } catch (err) {
  clearTimeout(timeoutId);
  if (err.name === 'AbortError' || controller.signal.aborted || err.message?.includes('aborted')) {
   throw new Error('Profile update timed out after 15 seconds. Please check your connection and try again.');
  }
  throw err;
 }
}

export async function checkUsernameAvailability(username, currentUserId=null){
 const clean=String(username??'').trim().toLowerCase();
 if(!clean||!/^[a-z0-9_]{3,30}$/.test(clean)){
  return {available:false,normalized:clean,reason:'Username must be 3–30 characters and contain only lowercase letters, numbers, and underscores.'};
 }
 const db=await getSupabase();
 const controller = new AbortController();
 const timeoutId = setTimeout(() => controller.abort(), 8000);
 try {
  let query=db.from('profiles').select('id').eq('username',clean);
  if(currentUserId){
   query=query.neq('id',currentUserId);
  }
  if(typeof query.abortSignal === 'function'){
   query=query.abortSignal(controller.signal);
  }
  const {data,error}=await query.maybeSingle();
  clearTimeout(timeoutId);
  if(error) throw error;
  if(data){
   return {available:false,normalized:clean,reason:'This username is already taken.'};
  }
  return {available:true,normalized:clean};
 } catch (err) {
  clearTimeout(timeoutId);
  if (err.name === 'AbortError' || controller.signal.aborted || err.message?.includes('aborted')) {
   throw new Error('Username check timed out.');
  }
  throw err;
 }
}

export async function getPublicProfile(identifier){
 const raw=String(identifier??'').trim();
 if(!raw) return null;
 const cleanUser=raw.replace(/^@/,'').toLowerCase();
 const isUuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw);

 const params=typeof location!=='undefined'?new URLSearchParams(location.search):null;
 const isDemo=params?.get('preview')==='1';
 if(isDemo){
  if(cleanUser==='soundify_listener'||raw==='demo-user-id'){
   return {
    id: 'demo-user-id',
    username: 'soundify_listener',
    display_name: 'Soundify Listener',
    avatar_url: null,
    avatar_path: null,
    bio: 'Electronic music enthusiast & SOUNDIFY explorer.',
    created_at: '2024-01-15T12:00:00Z'
   };
  }
  if(cleanUser==='alex_beats'||cleanUser==='alex'||raw==='user-alex-1234'){
   return {
    id: 'user-alex-1234',
    username: 'alex_beats',
    display_name: 'Alex Rivera',
    avatar_url: null,
    avatar_path: null,
    bio: 'Synthwave producer & ambient sound designer.',
    created_at: '2023-08-20T10:30:00Z'
   };
  }
 }

 const db=await getSupabase();
 const controller=new AbortController();
 const timeoutId=setTimeout(()=>controller.abort(), 10000);
 try{
  let query=db
   .from('profiles')
   .select('id,username,display_name,avatar_url,avatar_path,bio,created_at');
  if(isUuid){
   query=query.eq('id',raw);
  }else{
   query=query.eq('username',cleanUser);
  }
  if(typeof query.abortSignal==='function'){
   query=query.abortSignal(controller.signal);
  }
  const {data,error}=await query.maybeSingle();
  clearTimeout(timeoutId);
  if(error) throw error;
  return data||null;
 }catch(err){
  clearTimeout(timeoutId);
  if(err.name==='AbortError'||controller.signal.aborted||err.message?.includes('aborted')){
   throw new Error('Profile lookup timed out.');
  }
  throw err;
 }
}

export async function isAdmin(){
  try {
    const user = await getUser();
    if (!user) return false;

    const db = await getSupabase();
    const {data, error} = await db.rpc('soundify_is_admin');

    if (error) {
      console.warn('SOUNDIFY admin check unavailable:', error.message || error);
      return false;
    }

    return data === true;
  } catch (err) {
    console.warn('SOUNDIFY admin check unavailable:', err?.message || err);
    return false;
  }
}

export function displayNameFor(user,profile){
 if(profile?.display_name?.trim()) return profile.display_name.trim();
 const meta=user?.user_metadata || {};
 return meta.full_name || meta.name || user?.email?.split('@')[0] || 'Account';
}
