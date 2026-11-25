import {getSession, onAuthStateChange, signInWithGoogle, signInWithPassword, signUp} from './auth.js';

const statusEl = document.querySelector('#login-status');
const tabSignIn = document.querySelector('#tab-signin');
const tabSignUp = document.querySelector('#tab-signup');
const formSignIn = document.querySelector('#form-signin');
const formSignUp = document.querySelector('#form-signup');
const googleBtn = document.querySelector('#google');

function setStatus(msg, type = 'info') {
  if (!statusEl) return;
  statusEl.className = `login-status ${type}`;
  statusEl.textContent = msg;
}

// 1. Check for OAuth callback errors in URL
try {
  const hash = location.hash ? location.hash.replace(/^#/, '') : '';
  const hashParams = new URLSearchParams(hash);
  const searchParams = new URLSearchParams(location.search);
  const errorDesc = hashParams.get('error_description') || searchParams.get('error_description') || hashParams.get('error') || searchParams.get('error');
  if (errorDesc) {
    setStatus(`Authentication error: ${decodeURIComponent(errorDesc)}`, 'error');
  }
} catch (e) {
  console.warn('Could not parse URL auth errors:', e);
}

// 2. Reverse guard: If already authenticated, redirect to main application
(async () => {
  try {
    const session = await getSession();
    if (session?.user) {
      window.location.replace('index.html');
      return;
    }
  } catch (err) {
    console.warn('Session verification error on login page:', err);
  }
})();

// Listen for asynchronous sign-in (e.g. from cross-tab or OAuth return)
onAuthStateChange(session => {
  if (session?.user) {
    window.location.replace('index.html');
  }
});

// 3. Tab navigation (Sign In vs Sign Up)
function switchTab(mode) {
  if (mode === 'signup') {
    tabSignUp.classList.add('is-active');
    tabSignUp.setAttribute('aria-selected', 'true');
    tabSignIn.classList.remove('is-active');
    tabSignIn.setAttribute('aria-selected', 'false');
    formSignUp.hidden = false;
    formSignIn.hidden = true;
    setStatus('');
    const emailInput = document.querySelector('#signup-email');
    if (emailInput) emailInput.focus();
  } else {
    tabSignIn.classList.add('is-active');
    tabSignIn.setAttribute('aria-selected', 'true');
    tabSignUp.classList.remove('is-active');
    tabSignUp.setAttribute('aria-selected', 'false');
    formSignIn.hidden = false;
    formSignUp.hidden = true;
    setStatus('');
    const emailInput = document.querySelector('#signin-email');
    if (emailInput) emailInput.focus();
  }
}

if (tabSignIn && tabSignUp) {
  tabSignIn.addEventListener('click', () => switchTab('signin'));
  tabSignUp.addEventListener('click', () => switchTab('signup'));
}

// 4. Google OAuth handler
if (googleBtn) {
  googleBtn.addEventListener('click', async () => {
    setStatus('Redirecting to Google…', 'info');
    googleBtn.disabled = true;
    try {
      await signInWithGoogle();
    } catch (err) {
      googleBtn.disabled = false;
      setStatus(`Google sign-in is not available: ${err?.message || err}`, 'error');
    }
  });
}

// 5. Email/Password Sign-In form handler
if (formSignIn) {
  formSignIn.addEventListener('submit', async e => {
    e.preventDefault();
    const email = document.querySelector('#signin-email')?.value.trim();
    const password = document.querySelector('#signin-password')?.value;
    const submitBtn = document.querySelector('#signin-submit');

    if (!email || !password) {
      setStatus('Please enter both email and password.', 'error');
      return;
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Signing in…';
    }
    setStatus('Signing in…', 'info');

    try {
      const data = await signInWithPassword(email, password);
      if (data?.session || data?.user) {
        setStatus('Signed in successfully! Redirecting…', 'success');
        window.location.replace('index.html');
      } else {
        setStatus('Check your credentials and try again.', 'error');
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Sign In';
        }
      }
    } catch (err) {
      const message = err?.message || 'Could not sign in with email.';
      setStatus(message, 'error');
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Sign In';
      }
    }
  });
}

// 6. Email/Password Sign-Up form handler
if (formSignUp) {
  formSignUp.addEventListener('submit', async e => {
    e.preventDefault();
    const email = document.querySelector('#signup-email')?.value.trim();
    const password = document.querySelector('#signup-password')?.value;
    const submitBtn = document.querySelector('#signup-submit');

    if (!email || !password) {
      setStatus('Please enter both email and password.', 'error');
      return;
    }

    if (password.length < 6) {
      setStatus('Password must be at least 6 characters.', 'error');
      return;
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating account…';
    }
    setStatus('Creating account…', 'info');

    try {
      const data = await signUp(email, password);
      if (data?.session) {
        setStatus('Account created! Redirecting…', 'success');
        window.location.replace('index.html');
      } else if (data?.user) {
        setStatus('Account created! Please check your email to confirm your account before signing in.', 'success');
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Create Account';
        }
      } else {
        setStatus('Account created! You can now sign in.', 'success');
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Create Account';
        }
      }
    } catch (err) {
      const message = err?.message || 'Could not create account.';
      setStatus(message, 'error');
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create Account';
      }
    }
  });
}
