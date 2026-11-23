import {signInWithGoogle} from './auth.js';

const status=document.querySelector('#login-status');

document.querySelector('#google').onclick=async()=>{
 if(status) status.textContent='Redirecting to Google…';
 try {
  await signInWithGoogle();
 } catch (err) {
  if(status) status.textContent=`Google sign-in is not available yet: ${err?.message || err}`;
 }
};

document.querySelector('#guest').onclick=()=>{
 try{sessionStorage.setItem('soundifyGuest','true');}catch{/* Guest access still works without storage. */}
 location.href='index.html';
};

