import {SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY} from './supabase-config.js';

export const configured = SUPABASE_URL !== 'YOUR_SUPABASE_URL' || SUPABASE_PUBLISHABLE_KEY !== 'YOUR_SUPABASE_PUBLISHABLE_KEY';
let clientPromise;
let sdkPromise;
export function getSupabase(){
 return clientPromise ??= (async()=>{
  const url=new URL(SUPABASE_URL);
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash || !/^sb_publishable_[\w-]+$/.test(SUPABASE_PUBLISHABLE_KEY)) throw new Error('Use the HTTPS project URL and an sb_publishable_ key.');
  sdkPromise ??= import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.86.0/+esm').catch(err=>{sdkPromise=undefined;throw err;});
  const {createClient}=await sdkPromise;
  return createClient(url.origin,SUPABASE_PUBLISHABLE_KEY,{
   auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true},
   global:{fetch:(resource,options)=>{
    if(options?.signal) return fetch(resource, options);
    const timeoutSignal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(20000) : undefined;
    return fetch(resource, timeoutSignal ? {...options, signal: timeoutSignal} : options);
   }}
  });
 })().catch(err=>{clientPromise=undefined;throw err;});
}
