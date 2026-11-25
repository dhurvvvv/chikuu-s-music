import {getSupabase} from './supabase.js';

let _uidCounter = 0;

export function createQueueItem(trackId, origin = 'context', contextTitle = '') {
  const uid = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'q-' + Math.random().toString(36).slice(2, 9) + '-' + Date.now() + '-' + (++_uidCounter);
  return {
    uid,
    trackId,
    origin, // 'context' | 'manual'
    contextTitle: contextTitle || ''
  };
}

export function checkCrossfadeSupport() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS) return false;
  return true;
}

export function createPlayer(songs = [], onChange, onPlayed) {
  // Dual HTMLAudioElement Architecture
  const audioA = new Audio();
  const audioB = new Audio();
  audioA.preload = 'metadata';
  audioB.preload = 'metadata';

  let primaryAudio = audioA;
  let secondaryAudio = audioB;
  let primaryElementId = 'A'; // 'A' | 'B'

  let currentLoad = 0;
  let loadedTrackId = null;

  // Stacks & Queues
  let manualQueue = [];       // QueueItem[]
  let contextQueue = [];      // QueueItem[]
  let contextIndex = -1;      // active index in contextQueue
  let historyStack = [];      // QueueItem[]
  let futureStack = [];       // QueueItem[]
  let sessionSequence = [];   // QueueItem[] (canonical initial sequence)
  let canonicalContextOrder = []; // QueueItem[] (for shuffle restore)
  let activeItem = null;      // QueueItem | null

  // Sleep timer interval handle
  let sleepInterval = null;

  // Crossfade Engine State
  let crossfadeDuration = 0; // 0 (Off), 2, 4, 6
  let primaryCrossfadeGain = 1.0;
  let secondaryCrossfadeGain = 0.0;
  let activeReservation = null;
  let pendingSessionCycleSnapshot = null;
  let crossfadeRafId = null;
  let generationCounter = 0;
  let primaryGeneration = ++generationCounter;
  let secondaryGeneration = ++generationCounter;
  let reservationCounter = 0;

  // Initialize contextual queue with initial songs
  if (Array.isArray(songs) && songs.length > 0) {
    contextQueue = songs.map(s => createQueueItem(s.id, 'context', 'Library'));
    sessionSequence = [...contextQueue];
    canonicalContextOrder = [...contextQueue];
    contextIndex = 0;
    activeItem = contextQueue[0];
  }

  const state = {
    id: activeItem?.trackId || songs[0]?.id || null,
    queue: songs.map(s => s.id),
    playing: false,
    time: 0,
    volume: 72,
    muted: false,
    shuffle: false,
    repeat: 'off', // 'off' | 'all' | 'one'
    loading: false,
    error: null,
    currentUid: activeItem?.uid || null,
    playbackRate: 1.0,
    playbackRateSupported: true,
    sleepDeadline: null,      // timestamp ms or null
    sleepEndOfTrack: false,   // boolean
    sleepFadeFactor: 1.0,     // 0.0 - 1.0
    audioGain: 1.0            // 0.0 - 1.0
  };

  function syncQueueArray() {
    // Keep state.queue synchronized as an Array of string track IDs for full backward compatibility
    const upcomingContext = contextIndex >= 0 ? contextQueue.slice(contextIndex + 1) : contextQueue;
    state.queue = [...manualQueue.map(i => i.trackId), ...upcomingContext.map(i => i.trackId)];
    // Ensure active track is findable in queue or fallback to context list
    if (state.id && !state.queue.includes(state.id)) {
      state.queue = [state.id, ...state.queue];
    }
  }

  syncQueueArray();

  const current = () => songs.find(s => s.id === state.id) || null;

  function stopAudio() {
    try {
      primaryAudio.pause();
      primaryAudio.removeAttribute('src');
      primaryAudio.load();
    } catch {}
    try {
      secondaryAudio.pause();
      secondaryAudio.removeAttribute('src');
      secondaryAudio.load();
    } catch {}
  }

  function teardownSecondaryAudio() {
    try {
      secondaryAudio.pause();
      secondaryAudio.removeAttribute('src');
      secondaryAudio.load();
    } catch {}
  }

  function applyEffectiveVolume() {
    const channel = arguments[0] || 'both';
    const baseVolume = state.muted ? 0 : Math.max(0, Math.min(100, Number(state.volume) || 0)) / 100;
    const clampedFade = Math.max(0, Math.min(1, typeof state.sleepFadeFactor === 'number' ? state.sleepFadeFactor : 1.0));
    const clampedGain = Math.max(0, Math.min(1, typeof state.audioGain === 'number' ? state.audioGain : 1.0));
    const commonHeadroom = baseVolume * clampedFade * clampedGain;

    const effPrimary = Math.max(0, Math.min(1, commonHeadroom * primaryCrossfadeGain));
    const effSecondary = Math.max(0, Math.min(1, commonHeadroom * secondaryCrossfadeGain));

    if (channel === 'both' || channel === 'primary') {
      try {
        if (primaryAudio) {
          primaryAudio.volume = effPrimary;
        }
      } catch {}
    }
    if (channel === 'both' || channel === 'secondary') {
      try {
        if (secondaryAudio) {
          secondaryAudio.volume = effSecondary;
        }
      } catch {}
    }
    return effPrimary;
  }

  function checkPlaybackRateSupport() {
    const targetElement = arguments[0] || primaryAudio;
    const audio = targetElement;
    if (!audio || typeof audio.playbackRate !== 'number') return false;
    const originalRate = audio.playbackRate;
    try {
      const probeRate = Math.abs(originalRate - 1.25) < 0.01 ? 1.5 : 1.25;
      audio.playbackRate = probeRate;
      return Math.abs(audio.playbackRate - probeRate) < 0.01;
    } catch {
      return false;
    } finally {
      try {
        audio.playbackRate = originalRate;
      } catch {}
    }
  }

  function setPlaybackRate(rate) {
    const num = Number(rate);
    const supportedRates = [0.8, 1.0, 1.25, 1.5, 2.0];
    const targetRate = supportedRates.includes(num) ? num : Math.max(0.5, Math.min(2.0, num || 1.0));
    state.playbackRate = targetRate;
    state.playbackRateSupported = checkPlaybackRateSupport(primaryAudio);
    if (state.playbackRateSupported && primaryAudio) {
      try {
        primaryAudio.playbackRate = targetRate;
      } catch (err) {
        console.warn('Playback rate could not be set on primary audio element:', err);
      }
    }
    if (activeReservation && secondaryAudio) {
      const secSupported = checkPlaybackRateSupport(secondaryAudio);
      if (secSupported) {
        try {
          secondaryAudio.playbackRate = targetRate;
        } catch {
          cancelCrossfadeReservation('secondary_playback_rate_error');
        }
      } else {
        cancelCrossfadeReservation('secondary_playback_rate_unsupported');
      }
    }
    onChange?.();
    return state.playbackRate;
  }

  function clearSleepTimer() {
    if (sleepInterval) {
      clearInterval(sleepInterval);
      sleepInterval = null;
    }
    state.sleepDeadline = null;
    state.sleepEndOfTrack = false;
    state.sleepFadeFactor = 1.0;
    applyEffectiveVolume();
    onChange?.();
  }

  function checkSleepTimerTick() {
    if (!state.sleepDeadline) return;
    const remaining = state.sleepDeadline - Date.now();
    if (remaining <= 0) {
      if (sleepInterval) {
        clearInterval(sleepInterval);
        sleepInterval = null;
      }
      state.sleepDeadline = null;
      state.sleepFadeFactor = 1.0;
      cancelCrossfadeReservation('sleep_deadline');
      stopAudio();
      state.playing = false;
      state.time = 0;
      applyEffectiveVolume();
      onChange?.();
    } else if (remaining <= 5000) {
      state.sleepFadeFactor = Math.max(0, Math.min(1, remaining / 5000));
      applyEffectiveVolume();
      onChange?.();
    } else {
      if (state.sleepFadeFactor !== 1.0) {
        state.sleepFadeFactor = 1.0;
        applyEffectiveVolume();
      }
    }
  }

  function setSleepTimer(minutesOrDuration, endOfTrack = false) {
    clearSleepTimer();
    if (endOfTrack) {
      state.sleepEndOfTrack = true;
      state.sleepDeadline = null;
      state.sleepFadeFactor = 1.0;
      cancelCrossfadeReservation('sleep_end_of_track');
      onChange?.();
      return;
    }
    const mins = Number(minutesOrDuration);
    if (!mins || mins <= 0) {
      clearSleepTimer();
      return;
    }
    state.sleepEndOfTrack = false;
    const durationMs = mins * 60 * 1000;
    state.sleepDeadline = Date.now() + durationMs;
    state.sleepFadeFactor = 1.0;
    sleepInterval = setInterval(checkSleepTimerTick, 500);
    onChange?.();
  }

  async function resolveAudioUrl(song) {
    if (!song?.audioPath) return null;
    if (song.audioPath.startsWith('http://') || song.audioPath.startsWith('https://') || song.audioPath.startsWith('blob:') || song.audioPath.startsWith('data:')) {
      return song.audioPath;
    }
    try {
      const db = await getSupabase();
      const {data, error} = await db.storage.from('music').createSignedUrl(song.audioPath, 600);
      if (error) throw error;
      return data?.signedUrl || null;
    } catch (err) {
      if (typeof window === 'undefined') {
        return song.audioPath;
      }
      throw err;
    }
  }

  // Crossfade Management & Configuration
  function setCrossfade(seconds) {
    const isSupported = checkCrossfadeSupport();
    if (!isSupported) {
      crossfadeDuration = 0;
      cancelCrossfadeReservation('unsupported_platform');
      return 0;
    }
    const num = Number(seconds);
    if ([0, 2, 4, 6].includes(num)) {
      crossfadeDuration = num;
    } else {
      crossfadeDuration = 0;
    }
    if (crossfadeDuration === 0) {
      cancelCrossfadeReservation('crossfade_disabled');
    }
    return crossfadeDuration;
  }

  function getCrossfade() {
    return crossfadeDuration;
  }

  function cancelCrossfadeReservation(reason = '') {
    if (!activeReservation) return;
    activeReservation.state = 'cancelled';
    if (crossfadeRafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(crossfadeRafId);
      crossfadeRafId = null;
    }
    secondaryGeneration = ++generationCounter;
    teardownSecondaryAudio();
    primaryCrossfadeGain = 1.0;
    secondaryCrossfadeGain = 0.0;
    applyEffectiveVolume();
    activeReservation = null;
  }

  function peekNextQueueItem(isNaturalProgression = true) {
    if (state.sleepEndOfTrack) {
      return { item: null, source: 'sleep_stop' };
    }
    if (isNaturalProgression && state.repeat === 'one') {
      return { item: activeItem, source: 'repeat_one' };
    }
    if (futureStack.length > 0) {
      return { 
        item: futureStack[futureStack.length - 1], 
        source: 'futureStack' 
      };
    }
    if (manualQueue.length > 0) {
      return { 
        item: manualQueue[0], 
        source: 'manualQueue' 
      };
    }
    if (contextIndex < contextQueue.length - 1) {
      return { 
        item: contextQueue[contextIndex + 1], 
        source: 'contextQueue' 
      };
    }
    if (state.repeat === 'all') {
      if (contextQueue.length > 0) {
        return { 
          item: contextQueue[0], 
          source: 'repeat_all_context' 
        };
      }
      if (sessionSequence.length > 0) {
        if (!pendingSessionCycleSnapshot) {
          pendingSessionCycleSnapshot = sessionSequence.map(i => createQueueItem(i.trackId, 'context', i.contextTitle));
        }
        return { 
          item: pendingSessionCycleSnapshot[0], 
          source: 'repeat_all_session' 
        };
      }
    }
    return { item: null, source: 'none' };
  }

  async function prepareSecondaryAudio(reservation, trackId) {
    const song = songs.find(s => s.id === trackId);
    if (!song) {
      cancelCrossfadeReservation('secondary_song_not_found');
      return;
    }
    let url = null;
    try {
      url = await resolveAudioUrl(song);
    } catch {
      if (!activeReservation || activeReservation.token !== reservation.token || activeReservation.generation !== reservation.generation) return;
      cancelCrossfadeReservation('secondary_url_error');
      return;
    }
    if (!activeReservation || activeReservation.token !== reservation.token || activeReservation.generation !== reservation.generation) return;
    if (!url) {
      cancelCrossfadeReservation('secondary_no_url');
      return;
    }

    secondaryAudio.src = url;
    if (state.playbackRateSupported && secondaryAudio) {
      try {
        secondaryAudio.playbackRate = primaryAudio.playbackRate || state.playbackRate;
      } catch {}
    }
    secondaryCrossfadeGain = 0.0;
    applyEffectiveVolume('secondary');

    try {
      secondaryAudio.load();
    } catch {}

    try {
      await secondaryAudio.play();
    } catch (err) {
      if (!activeReservation || activeReservation.token !== reservation.token || activeReservation.generation !== reservation.generation) return;
      cancelCrossfadeReservation('secondary_play_rejected');
      return;
    }

    if (!activeReservation || activeReservation.token !== reservation.token || activeReservation.generation !== reservation.generation) {
      teardownSecondaryAudio();
      return;
    }

    // Secondary element enters ready state pre-rolled at gain 0
    reservation.state = 'ready';
  }

  function checkCrossfadeProgressTick() {
    if (crossfadeDuration <= 0) return;
    const dur = primaryAudio.duration;
    if (!Number.isFinite(dur) || dur < (2 * crossfadeDuration + 2)) return;

    const curTime = primaryAudio.currentTime || 0;
    const prepTime = dur - (crossfadeDuration + 5);
    const fadeTimelineStart = dur - crossfadeDuration;

    // Preparation Window: primaryAudio.currentTime is inside [prepTime, fadeTimelineStart)
    if (curTime >= prepTime && curTime < fadeTimelineStart && !activeReservation) {
      const peeked = peekNextQueueItem(true);
      if (peeked.item && peeked.source !== 'repeat_one' && peeked.source !== 'sleep_stop' && peeked.source !== 'none') {
        const token = ++reservationCounter;
        const secGen = ++secondaryGeneration;
        activeReservation = {
          token,
          uid: peeked.item.uid,
          trackId: peeked.item.trackId,
          source: peeked.source,
          generation: secGen,
          state: 'preparing',
          committed: false,
          fadeDuration: crossfadeDuration,
          fadeTimelineStart
        };
        prepareSecondaryAudio(activeReservation, peeked.item.trackId);
      }
      return;
    }

    // Fade Boundary: primaryAudio.currentTime >= fadeTimelineStart
    if (curTime >= fadeTimelineStart && activeReservation) {
      if (activeReservation.state === 'ready') {
        const isSecPlaying = !secondaryAudio.paused && secondaryAudio.currentTime >= 0 && secondaryAudio.readyState >= 3 && !secondaryAudio.error;
        if (isSecPlaying && (typeof document === 'undefined' || !document.hidden)) {
          activeReservation.state = 'fading';
          activeReservation.fadeTimelineStart = fadeTimelineStart;
          runCrossfadeRafLoop();
        } else {
          // Late readiness: cancel immediately to prevent volume jumps
          cancelCrossfadeReservation('secondary_not_ready_at_boundary');
        }
      } else if (activeReservation.state === 'preparing') {
        // Boundary arrived before secondary became ready: cancel immediately!
        cancelCrossfadeReservation('secondary_not_ready_on_time');
      }
    }

    // Watchdog check in timeupdate while actively fading
    if (activeReservation && activeReservation.state === 'fading') {
      if (curTime >= activeReservation.fadeTimelineStart + activeReservation.fadeDuration) {
        commitCrossfadeHandoff('timeupdate_complete');
      }
    }
  }

  function runCrossfadeRafLoop() {
    if (!activeReservation || activeReservation.state !== 'fading') return;
    if (typeof document !== 'undefined' && document.hidden) {
      cancelCrossfadeReservation('document_hidden');
      return;
    }

    const cur = primaryAudio.currentTime || 0;
    const rawProgress = (cur - activeReservation.fadeTimelineStart) / activeReservation.fadeDuration;
    const progress = Math.max(0, Math.min(1, rawProgress));

    primaryCrossfadeGain = Math.cos(progress * Math.PI * 0.5);
    secondaryCrossfadeGain = Math.sin(progress * Math.PI * 0.5);
    applyEffectiveVolume();

    if (progress >= 1.0) {
      commitCrossfadeHandoff('raf_complete');
      return;
    }

    if (typeof requestAnimationFrame === 'function') {
      crossfadeRafId = requestAnimationFrame(runCrossfadeRafLoop);
    }
  }

  function commitCrossfadeHandoff(caller = '') {
    if (!activeReservation || activeReservation.committed || activeReservation.state !== 'fading') {
      return false;
    }
    if (crossfadeRafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(crossfadeRafId);
      crossfadeRafId = null;
    }

    const reservedUid = activeReservation.uid;
    const oldActiveItem = activeItem;
    let reservedQueueItem = null;

    // Validate the exact reserved UID still exists at the expected source and position
    if (activeReservation.source === 'futureStack') {
      if (futureStack.length === 0 || futureStack[futureStack.length - 1].uid !== reservedUid) {
        cancelCrossfadeReservation('futureStack_mismatch');
        return false;
      }
      reservedQueueItem = futureStack.pop();
    } else if (activeReservation.source === 'manualQueue') {
      if (manualQueue.length === 0 || manualQueue[0].uid !== reservedUid) {
        cancelCrossfadeReservation('manualQueue_mismatch');
        return false;
      }
      reservedQueueItem = manualQueue.shift();
    } else if (activeReservation.source === 'contextQueue') {
      if (contextIndex + 1 >= contextQueue.length || contextQueue[contextIndex + 1].uid !== reservedUid) {
        cancelCrossfadeReservation('contextQueue_mismatch');
        return false;
      }
      contextIndex++;
      reservedQueueItem = contextQueue[contextIndex];
    } else if (activeReservation.source === 'repeat_all_context') {
      if (contextQueue.length === 0 || contextQueue[0].uid !== reservedUid) {
        cancelCrossfadeReservation('repeat_context_mismatch');
        return false;
      }
      contextIndex = 0;
      reservedQueueItem = contextQueue[0];
    } else if (activeReservation.source === 'repeat_all_session') {
      if (!pendingSessionCycleSnapshot || pendingSessionCycleSnapshot[0].uid !== reservedUid) {
        cancelCrossfadeReservation('session_snapshot_mismatch');
        return false;
      }
      contextQueue = pendingSessionCycleSnapshot;
      contextIndex = 0;
      reservedQueueItem = contextQueue[0];
      pendingSessionCycleSnapshot = null;
    } else {
      cancelCrossfadeReservation('unknown_source');
      return false;
    }

    // Validate secondary element is actually playing and healthy
    const secHealthy = !secondaryAudio.paused && secondaryAudio.currentTime > 0 && secondaryAudio.readyState >= 3 && !secondaryAudio.error;
    if (!secHealthy) {
      if (activeReservation.source === 'futureStack') futureStack.push(reservedQueueItem);
      else if (activeReservation.source === 'manualQueue') manualQueue.unshift(reservedQueueItem);
      else if (activeReservation.source === 'contextQueue') contextIndex--;
      cancelCrossfadeReservation('secondary_unhealthy_at_commit');
      return false;
    }

    // Atomically mark committed
    activeReservation.committed = true;
    activeReservation.state = 'committed';

    // Push old active item to historyStack
    if (oldActiveItem) {
      historyStack.push(oldActiveItem);
    }

    // Set activeItem to reserved item
    activeItem = reservedQueueItem;

    // Swap audio roles
    const oldPrimary = primaryAudio;
    primaryAudio = secondaryAudio;
    secondaryAudio = oldPrimary;

    primaryElementId = primaryElementId === 'A' ? 'B' : 'A';
    primaryGeneration = ++generationCounter;
    secondaryGeneration = ++generationCounter;

    // Teardown old primary (now secondary)
    teardownSecondaryAudio();

    // Reset crossfade gains
    primaryCrossfadeGain = 1.0;
    secondaryCrossfadeGain = 0.0;

    // Update public playback state fields
    const promotedSong = songs.find(s => s.id === activeItem.trackId);
    state.id = activeItem.trackId;
    state.currentUid = activeItem.uid;
    state.time = Math.floor(primaryAudio.currentTime || 0);
    state.duration = Math.round(primaryAudio.duration || promotedSong?.duration || 0);
    state.loading = false;
    state.playing = true;
    state.error = null;

    if (state.playbackRateSupported && primaryAudio) {
      try { primaryAudio.playbackRate = state.playbackRate; } catch {}
    }

    applyEffectiveVolume();
    syncQueueArray();
    onPlayed?.(state.id);

    activeReservation = null;
    onChange?.();
    return true;
  }

  function handleElementEnded(elementId) {
    if (elementId !== primaryElementId) return;

    if (activeReservation && activeReservation.state === 'fading') {
      const dur = primaryAudio.duration || 0;
      const cur = primaryAudio.currentTime || 0;
      const rawProgress = dur > 0 ? (cur - activeReservation.fadeTimelineStart) / activeReservation.fadeDuration : 0;
      const secondaryHealthy = !secondaryAudio.paused && secondaryAudio.currentTime > 0 && secondaryAudio.readyState >= 3 && !secondaryAudio.error;

      if (rawProgress >= 1.0 && secondaryHealthy) {
        commitCrossfadeHandoff('primary_ended_completed');
        return;
      } else {
        cancelCrossfadeReservation('primary_ended_incomplete');
      }
    }

    if (state.sleepEndOfTrack) {
      clearSleepTimer();
      stopAudio();
      state.playing = false;
      state.time = 0;
      onChange?.();
      return;
    }

    step(1, false);
  }

  function bindAudioListeners(element, elementId) {
    element.addEventListener('timeupdate', () => {
      if (elementId !== primaryElementId) return;
      if (state.id && !state.loading) {
        state.time = Math.floor(element.currentTime || 0);
        checkSleepTimerTick();
        checkCrossfadeProgressTick();
        onChange?.();
      }
    });

    element.addEventListener('ended', () => {
      handleElementEnded(elementId);
    });

    element.addEventListener('error', () => {
      if (elementId !== primaryElementId) {
        if (activeReservation && activeReservation.state === 'fading') {
          cancelCrossfadeReservation('secondary_error');
        }
        return;
      }
      if (!element.src) return;
      if (element.error?.code === 1 || (typeof MediaError !== 'undefined' && element.error?.code === MediaError.MEDIA_ERR_ABORTED)) {
        return;
      }
      state.loading = false;
      state.playing = false;
      state.error = 'Audio file could not be played.';
      onChange?.();
    });

    element.addEventListener('waiting', () => {
      if (elementId === primaryElementId) {
        state.loading = true;
        onChange?.();
      } else if (activeReservation && activeReservation.state === 'fading') {
        cancelCrossfadeReservation('secondary_waiting');
      }
    });

    element.addEventListener('canplay', () => {
      if (elementId === primaryElementId) {
        state.loading = false;
        onChange?.();
      }
    });

    element.addEventListener('stalled', () => {
      if (elementId !== primaryElementId && activeReservation && activeReservation.state === 'fading') {
        cancelCrossfadeReservation('secondary_stalled');
      }
    });
  }

  bindAudioListeners(audioA, 'A');
  bindAudioListeners(audioB, 'B');

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && activeReservation) {
        cancelCrossfadeReservation('document_hidden');
      }
    });
  }

  async function loadAndPlay(id) {
    const token = ++currentLoad;
    primaryGeneration = ++generationCounter;
    cancelCrossfadeReservation('new_track_load');
    const song = songs.find(s => s.id === id);
    stopAudio();
    loadedTrackId = null;
    state.loading = true;
    state.error = null;
    state.time = 0;
    onChange?.();

    if (!song) {
      state.loading = false;
      state.playing = false;
      state.error = 'Track could not be found in the catalog.';
      onChange?.();
      return;
    }

    let url = null;
    try {
      url = await resolveAudioUrl(song);
    } catch (err) {
      if (token !== currentLoad) return;
      stopAudio();
      loadedTrackId = null;
      state.loading = false;
      state.playing = false;
      state.error = err?.message || 'Audio could not be loaded.';
      onChange?.();
      return;
    }

    if (token !== currentLoad) return;

    if (!url) {
      stopAudio();
      loadedTrackId = null;
      state.loading = false;
      state.playing = false;
      state.error = 'No audio file is available for this track.';
      onChange?.();
      return;
    }

    primaryAudio.src = url;
    loadedTrackId = id;

    applyEffectiveVolume();

    if (state.playbackRateSupported && primaryAudio) {
      try {
        primaryAudio.playbackRate = state.playbackRate;
      } catch {}
    }

    try {
      primaryAudio.currentTime = 0;
    } catch {}

    try {
      await primaryAudio.play();
    } catch (err) {
      if (token !== currentLoad) return;
      if (err?.name === 'AbortError') {
        state.playing = !primaryAudio.paused;
        state.loading = false;
        onChange?.();
        return;
      }
      state.loading = false;
      state.playing = false;
      state.error = err?.message || 'Playback was blocked by the browser.';
      onChange?.();
      return;
    }

    if (token !== currentLoad) {
      stopAudio();
      loadedTrackId = null;
      return;
    }

    state.loading = false;
    state.playing = true;
    state.time = 0;
    onPlayed?.(id);
    onChange?.();
  }

  function select(id, queue = state.queue, contextTitle = '') {
    if (!songs.some(s => s.id === id)) return;
    cancelCrossfadeReservation('manual_select');
    pendingSessionCycleSnapshot = null;
    stopAudio();
    loadedTrackId = null;

    const validQueue = Array.isArray(queue)
      ? queue.filter(qid => {
          const checkId = typeof qid === 'object' && qid?.trackId ? qid.trackId : qid;
          return songs.some(s => s.id === checkId);
        })
      : [];

    if (validQueue.length) {
      contextQueue = validQueue.map(entry => {
        const tid = typeof entry === 'object' && entry.trackId ? entry.trackId : entry;
        return createQueueItem(tid, 'context', contextTitle);
      });
      const foundIdx = contextQueue.findIndex(i => i.trackId === id);
      if (foundIdx !== -1) {
        contextIndex = foundIdx;
      } else {
        const newItem = createQueueItem(id, 'context', contextTitle);
        contextQueue.unshift(newItem);
        contextIndex = 0;
      }
    } else {
      contextQueue = songs.map(s => createQueueItem(s.id, 'context', 'Library'));
      contextIndex = Math.max(0, contextQueue.findIndex(i => i.trackId === id));
    }

    sessionSequence = [...contextQueue];
    canonicalContextOrder = [...contextQueue];
    manualQueue = [];
    futureStack = []; // Catalog/list selection resets futureStack

    activeItem = contextQueue[contextIndex] || createQueueItem(id, 'context', contextTitle);
    state.currentUid = activeItem.uid;
    state.id = id;
    state.time = 0;
    state.playing = true;
    state.loading = true;
    state.error = null;

    syncQueueArray();
    onChange?.();
    loadAndPlay(id);
  }

  function selectQueueItem(uid) {
    if (!uid) return;
    cancelCrossfadeReservation('select_queue_item');
    pendingSessionCycleSnapshot = null;

    // Check manual queue
    const mIdx = manualQueue.findIndex(i => i.uid === uid);
    if (mIdx !== -1) {
      const item = manualQueue.splice(mIdx, 1)[0];
      if (activeItem) historyStack.push(activeItem);
      futureStack = [];
      activeItem = item;
      state.currentUid = item.uid;
      state.id = item.trackId;
      syncQueueArray();
      onChange?.();
      loadAndPlay(item.trackId);
      return;
    }
    // Check context queue
    const cIdx = contextQueue.findIndex(i => i.uid === uid);
    if (cIdx !== -1) {
      if (activeItem) historyStack.push(activeItem);
      futureStack = [];
      contextIndex = cIdx;
      activeItem = contextQueue[cIdx];
      state.currentUid = activeItem.uid;
      state.id = activeItem.trackId;
      syncQueueArray();
      onChange?.();
      loadAndPlay(activeItem.trackId);
      return;
    }
  }

  function playNext(trackId, contextTitle = 'Play Next') {
    if (!songs.some(s => s.id === trackId)) return null;
    cancelCrossfadeReservation('play_next');
    const item = createQueueItem(trackId, 'manual', contextTitle);
    manualQueue.unshift(item);
    futureStack = []; // Invalidate forward stack
    syncQueueArray();
    onChange?.();
    return item;
  }

  function addToQueue(trackId, contextTitle = 'Queue') {
    if (!songs.some(s => s.id === trackId)) return null;
    cancelCrossfadeReservation('add_to_queue');
    const item = createQueueItem(trackId, 'manual', contextTitle);
    manualQueue.push(item);
    syncQueueArray();
    onChange?.();
    return item;
  }

  function removeFromQueue(uid) {
    if (!uid) return false;
    cancelCrossfadeReservation('remove_from_queue');
    let removed = false;
    const mIdx = manualQueue.findIndex(i => i.uid === uid);
    if (mIdx !== -1) {
      manualQueue.splice(mIdx, 1);
      removed = true;
    }
    const cIdx = contextQueue.findIndex(i => i.uid === uid);
    if (cIdx !== -1) {
      contextQueue.splice(cIdx, 1);
      if (cIdx <= contextIndex && contextIndex > 0) {
        contextIndex--;
      }
      removed = true;
    }
    const fIdx = futureStack.findIndex(i => i.uid === uid);
    if (fIdx !== -1) {
      futureStack.splice(fIdx, 1);
      removed = true;
    }
    if (removed) {
      syncQueueArray();
      onChange?.();
    }
    return removed;
  }

  function clearUpcoming() {
    cancelCrossfadeReservation('clear_upcoming');
    pendingSessionCycleSnapshot = null;
    manualQueue = [];
    futureStack = [];
    if (contextIndex >= 0 && contextIndex < contextQueue.length) {
      contextQueue = contextQueue.slice(0, contextIndex + 1);
    }
    syncQueueArray();
    onChange?.();
  }

  function getQueueDetails() {
    const upcomingContext = contextIndex >= 0 ? contextQueue.slice(contextIndex + 1) : [...contextQueue];
    return {
      currentItem: activeItem ? {...activeItem} : null,
      currentUid: activeItem?.uid || null,
      manualQueue: manualQueue.map(item => ({...item})),
      contextQueue: contextQueue.map(item => ({...item})),
      contextIndex,
      historyStack: historyStack.map(item => ({...item})),
      futureStack: futureStack.map(item => ({...item})),
      upcoming: [...manualQueue, ...upcomingContext].map(item => ({...item})),
      repeat: state.repeat,
      shuffle: state.shuffle
    };
  }

  function step(dir, isUserExplicit = true) {
    cancelCrossfadeReservation('step_navigation');
    pendingSessionCycleSnapshot = null;

    if (dir > 0) {
      // 1. Natural track completion with Repeat One loops current track
      // Explicit user Next bypasses Repeat One!
      if (!isUserExplicit && state.repeat === 'one') {
        try {
          primaryAudio.currentTime = 0;
          state.time = 0;
          primaryAudio.play().catch(() => {});
        } catch {}
        return;
      }

      // 2. Future Stack restoration (from prior Previous navigation)
      if (futureStack.length > 0) {
        const nextItem = futureStack.pop();
        if (activeItem) historyStack.push(activeItem);
        activeItem = nextItem;
        state.currentUid = activeItem.uid;
        state.id = nextItem.trackId;
        const cIdx = contextQueue.findIndex(i => i.uid === activeItem.uid);
        if (cIdx !== -1) contextIndex = cIdx;
        syncQueueArray();
        loadAndPlay(activeItem.trackId);
        return;
      }

      // 3. Manual Queue priority
      if (manualQueue.length > 0) {
        const nextItem = manualQueue.shift();
        if (activeItem) historyStack.push(activeItem);
        activeItem = nextItem;
        state.currentUid = activeItem.uid;
        state.id = nextItem.trackId;
        syncQueueArray();
        loadAndPlay(nextItem.trackId);
        return;
      }

      // 4. Context Queue progression
      if (contextIndex < contextQueue.length - 1) {
        contextIndex++;
        const nextItem = contextQueue[contextIndex];
        if (activeItem) historyStack.push(activeItem);
        activeItem = nextItem;
        state.currentUid = activeItem.uid;
        state.id = nextItem.trackId;
        syncQueueArray();
        loadAndPlay(nextItem.trackId);
        return;
      }

      // 5. Repeat All
      if (state.repeat === 'all') {
        if (contextQueue.length > 0) {
          contextIndex = 0;
          const nextItem = contextQueue[0];
          if (activeItem) historyStack.push(activeItem);
          activeItem = nextItem;
          state.currentUid = activeItem.uid;
          state.id = nextItem.trackId;
          syncQueueArray();
          loadAndPlay(nextItem.trackId);
          return;
        } else if (sessionSequence.length > 0) {
          contextQueue = sessionSequence.map(i => createQueueItem(i.trackId, 'context', i.contextTitle));
          contextIndex = 0;
          const nextItem = contextQueue[0];
          if (activeItem) historyStack.push(activeItem);
          activeItem = nextItem;
          state.currentUid = activeItem.uid;
          state.id = nextItem.trackId;
          syncQueueArray();
          loadAndPlay(nextItem.trackId);
          return;
        }
      }

      // 6. Clean stop
      state.playing = false;
      state.time = 0;
      onChange?.();
      return;
    }

    if (dir < 0) {
      // 1. If played > 3 seconds, restart current track
      if ((primaryAudio.currentTime || 0) > 3) {
        try {
          primaryAudio.currentTime = 0;
        } catch {}
        state.time = 0;
        onChange?.();
        return;
      }

      // 2. History Stack traversal
      if (historyStack.length > 0) {
        const prevItem = historyStack.pop();
        if (activeItem) futureStack.push(activeItem);
        activeItem = prevItem;
        state.currentUid = activeItem.uid;
        state.id = activeItem.trackId;
        const cIdx = contextQueue.findIndex(i => i.uid === activeItem.uid);
        if (cIdx !== -1) contextIndex = cIdx;
        syncQueueArray();
        loadAndPlay(activeItem.trackId);
        return;
      }

      // 3. Context queue step backward if at beginning of history
      if (contextIndex > 0) {
        if (activeItem) futureStack.push(activeItem);
        contextIndex--;
        activeItem = contextQueue[contextIndex];
        state.currentUid = activeItem.uid;
        state.id = activeItem.trackId;
        syncQueueArray();
        loadAndPlay(activeItem.trackId);
        return;
      }

      // 4. Default restart
      try {
        primaryAudio.currentTime = 0;
      } catch {}
      state.time = 0;
      onChange?.();
    }
  }

  function pausePlayback() {
    if (crossfadeRafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(crossfadeRafId);
      crossfadeRafId = null;
    }
    secondaryGeneration = ++generationCounter;
    if (activeReservation) {
      activeReservation.state = 'cancelled';
      activeReservation = null;
    }
    pendingSessionCycleSnapshot = null;
    teardownSecondaryAudio();
    primaryCrossfadeGain = 1.0;
    secondaryCrossfadeGain = 0.0;
    applyEffectiveVolume('both');
    try { primaryAudio.pause(); } catch {}
    try { secondaryAudio.pause(); } catch {}
    state.playing = false;
    state.loading = false;
    onChange?.();
  }

  function resetPlayerForAccountSwitch() {
    currentLoad++;
    if (crossfadeRafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(crossfadeRafId);
      crossfadeRafId = null;
    }
    secondaryGeneration = ++generationCounter;
    if (activeReservation) {
      activeReservation.state = 'cancelled';
      activeReservation = null;
    }
    pendingSessionCycleSnapshot = null;
    stopAudio();
    primaryAudio = audioA;
    secondaryAudio = audioB;
    primaryElementId = 'A';
    clearSleepTimer();
    primaryCrossfadeGain = 1.0;
    secondaryCrossfadeGain = 0.0;
    state.audioGain = 1.0;
    state.sleepFadeFactor = 1.0;
    applyEffectiveVolume('both');
    state.playbackRate = 1.0;
    try { primaryAudio.playbackRate = 1.0; } catch {}
    try { secondaryAudio.playbackRate = 1.0; } catch {}
    state.shuffle = false;
    state.repeat = 'off';
    loadedTrackId = null;
    activeItem = null;
    manualQueue = [];
    contextQueue = [];
    contextIndex = -1;
    historyStack = [];
    futureStack = [];
    sessionSequence = [];
    canonicalContextOrder = [];
    state.id = null;
    state.currentUid = null;
    state.queue = [];
    state.playing = false;
    state.time = 0;
    state.loading = false;
    state.error = null;
    onChange?.();
  }

  function act(key, value) {
    if (!current()) return;

    if (key === 'play') {
      if (activeReservation && activeReservation.state === 'fading') {
        if (state.playing) {
          if (crossfadeRafId !== null && typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(crossfadeRafId);
            crossfadeRafId = null;
          }
          try { primaryAudio.pause(); } catch {}
          try { secondaryAudio.pause(); } catch {}
          state.playing = false;
          onChange?.();
        } else {
          state.loading = true;
          onChange?.();
          Promise.all([primaryAudio.play(), secondaryAudio.play()]).then(() => {
            state.playing = true;
            state.loading = false;
            if (typeof document === 'undefined' || !document.hidden) {
              runCrossfadeRafLoop();
            }
            onChange?.();
          }).catch(() => {
            try { primaryAudio.pause(); } catch {}
            try { secondaryAudio.pause(); } catch {}
            cancelCrossfadeReservation('resume_rejection');
            primaryCrossfadeGain = 1.0;
            secondaryCrossfadeGain = 0.0;
            applyEffectiveVolume();
            primaryAudio.play().then(() => {
              state.playing = true;
              state.loading = false;
              onChange?.();
            }).catch(pErr => {
              state.playing = false;
              state.loading = false;
              state.error = pErr?.name === 'AbortError' ? null : (pErr?.message || 'Playback was blocked by the browser.');
              onChange?.();
            });
          });
        }
        return;
      }

      if (state.playing) {
        primaryAudio.pause();
        state.playing = false;
        onChange?.();
      } else {
        if (loadedTrackId !== state.id || !primaryAudio.src || (typeof location !== 'undefined' && primaryAudio.src === location.href)) {
          loadAndPlay(state.id);
          return;
        }
        state.playing = true;
        primaryAudio.play().catch(err => {
          if (err?.name === 'AbortError') {
            state.playing = !primaryAudio.paused;
            state.loading = false;
            onChange?.();
            return;
          }
          state.playing = false;
          state.error = err?.message || 'Playback was blocked by the browser.';
          onChange?.();
        });
        onChange?.();
      }
      return;
    }

    if (key === 'next') return step(1, true);
    if (key === 'prev') return step(-1, true);

    if (key === 'repeat') {
      cancelCrossfadeReservation('repeat_mode_change');
      // 3-state repeat cycle: 'off' -> 'all' -> 'one' -> 'off'
      if (state.repeat === 'off' || state.repeat === false) {
        state.repeat = 'all';
      } else if (state.repeat === 'all' || state.repeat === true) {
        state.repeat = 'one';
      } else {
        state.repeat = 'off';
      }
      onChange?.();
      return;
    }

    if (key === 'shuffle') {
      cancelCrossfadeReservation('shuffle_mode_change');
      state.shuffle = !state.shuffle;
      futureStack = [];
      if (state.shuffle) {
        if (contextQueue.length > contextIndex + 1) {
          const played = contextQueue.slice(0, contextIndex + 1);
          const upcoming = contextQueue.slice(contextIndex + 1);
          for (let i = upcoming.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [upcoming[i], upcoming[j]] = [upcoming[j], upcoming[i]];
          }
          contextQueue = [...played, ...upcoming];
        }
      } else {
        if (canonicalContextOrder.length && contextQueue.length > contextIndex + 1) {
          const played = contextQueue.slice(0, contextIndex + 1);
          const playedUids = new Set(played.map(i => i.uid));
          const remainingCanonical = canonicalContextOrder.filter(i => !playedUids.has(i.uid));
          contextQueue = [...played, ...remainingCanonical];
        }
      }
      syncQueueArray();
      onChange?.();
      return;
    }

    if (key === 'muted') {
      state.muted = !state.muted;
      applyEffectiveVolume();
      onChange?.();
      return;
    }

    if (key === 'time') {
      cancelCrossfadeReservation('seek');
      const t = Number(value);
      if (Number.isFinite(t)) {
        try {
          primaryAudio.currentTime = t;
        } catch {}
        state.time = t;
        onChange?.();
      }
      return;
    }

    if (key === 'volume') {
      state.volume = Math.max(0, Math.min(100, Number(value) || 0));
      state.muted = false;
      applyEffectiveVolume();
      onChange?.();
      return;
    }

    if (key === 'playbackRate') {
      setPlaybackRate(value);
      return;
    }

    if (key === 'sleepTimer') {
      if (value === 'cancel' || value === false || value === 0) {
        clearSleepTimer();
      } else if (value === 'end_of_track') {
        setSleepTimer(0, true);
      } else {
        setSleepTimer(Number(value), false);
      }
      return;
    }

    if (key === 'crossfade') {
      setCrossfade(value);
      return;
    }
  }

  applyEffectiveVolume();

  return {
    state,
    current,
    select,
    selectQueueItem,
    act,
    get audio() {
      return primaryAudio;
    },
    playNext,
    addToQueue,
    removeFromQueue,
    clearUpcoming,
    setSleepTimer,
    clearSleepTimer,
    setPlaybackRate,
    checkPlaybackRateSupport,
    pausePlayback,
    resetPlayerForAccountSwitch,
    applyEffectiveVolume,
    getQueueDetails,
    setCrossfade,
    getCrossfade,
    checkCrossfadeSupport
  };
}
