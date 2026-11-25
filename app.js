import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, doc, setDoc, getDoc, collection,
  addDoc, onSnapshot, query, orderBy, serverTimestamp, deleteDoc, updateDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getStorage, ref, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyBt9QsBCwjWTu5YAfrlEkTpJhh1poGRbkE",
  authDomain: "gemix-communication.firebaseapp.com",
  projectId: "gemix-communication",
  storageBucket: "gemix-communication.firebasestorage.app",
  messagingSenderId: "338785603841",
  appId: "1:338785603841:web:818e5076276a41b15ecb00",
  measurementId: "G-F30JK6ZPZR"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const storage = getStorage(app);

let contacts = [];
let myProfile = { name: "", gemixNum: "", userId: "", masterKey: "", avatarUrl: "" };
let tempAvatarDataUrl = "";
window.activeChatPeer = { name: "", gemixId: "", initial: "", note: "", avatarUrl: "" };
let unsubscribeChatListener = null;
let unsubscribeIncomingCall = null;
let callStateUnsubscribe = null;
let unsubscribeLicenseListener = null;
let watchedLicenseSuffix = "";

// Long-Press Message Cache & Selection
let currentMessagesMap = {};
let selectedLongPressMsg = null;
let longPressTimer = null;

let peerConnection = null;
let currentCallDocId = null;
let incomingCallData = null;
const rtcServers = {
  iceServers: [
    { urls: ["stun:stun1.l.google.com:19302", "stun:stun2.l.google.com:19302"] }
  ]
};

let pendingMediaFile = null;
let pendingMediaUrl = null;
let isRecording = false;
let isRecordedReady = false;
let recSeconds = 0;
let recInterval = null;
let mediaRecorder = null;
let audioChunks = [];
let recordedAudioBlob = null;
let recordedAudioUrl = null;
let previewAudioElement = null;

let localStream = null;
let remoteStream = null;
let videoTimerInterval = null;
let videoSeconds = 0;
let useFrontCamera = true;
let isGroupSelectionMode = false;

function showToast(msg) {
  const pill = document.getElementById("toastPill");
  if (!pill) return;
  pill.innerText = msg;
  pill.style.display = "block";
  setTimeout(() => { pill.style.display = "none"; }, 2200);
}


// ============ PHASE 1: GEMIX SOUNDS + ONLINE PRESENCE ============
let gemixRingtoneAudio = null;
let gemixCallerTuneAudio = null;
let gemixAudioCtx = null;

function gemixGetSoundFile(kind) {
  if (kind === "ringtone") {
    const c = localStorage.getItem("gemix_custom_ringtone");
    if (c) return c;
    return "gemix-ringtone.wav";
  }
  if (kind === "caller") return "gemix-caller-tune.wav";
  return "gemix-notification.wav";
}

function gemixPlayTone(kind, loop) {
  try {
    const a = new Audio(gemixGetSoundFile(kind));
    a.loop = !!loop;
    a.volume = 0.9;
    a.play().catch(() => { window.playGemixSynthTone(kind); });
    return a;
  } catch (e) {
    window.playGemixSynthTone(kind);
    return null;
  }
}

window.playGemixRingtone = function () {
  if (gemixRingtoneAudio) gemixRingtoneAudio.pause();
  gemixRingtoneAudio = gemixPlayTone("ringtone", true);
};
window.stopGemixRingtone = function () {
  if (gemixRingtoneAudio) {
    gemixRingtoneAudio.pause();
    gemixRingtoneAudio.currentTime = 0;
    gemixRingtoneAudio = null;
  }
};
window.playGemixNotification = function () { gemixPlayTone("notification", false); };
window.playGemixCallerTune = function () {
  if (gemixCallerTuneAudio) gemixCallerTuneAudio.pause();
  gemixCallerTuneAudio = gemixPlayTone("caller", true);
};
window.stopGemixCallerTune = function () {
  if (gemixCallerTuneAudio) {
    gemixCallerTuneAudio.pause();
    gemixCallerTuneAudio.currentTime = 0;
    gemixCallerTuneAudio = null;
  }
};
window.setGemixCustomRingtoneFromFile = async function (event) {
  const file = event && event.target && event.target.files ? event.target.files[0] : null;
  if (!file) return;
  const dataUrl = await fileToBase64(file);
  localStorage.setItem("gemix_custom_ringtone", dataUrl);
  localStorage.setItem("gemix_custom_ringtone_name", file.name);
  showToast("Custom Ringtone Saved!");
};
window.clearGemixCustomRingtone = function () {
  localStorage.removeItem("gemix_custom_ringtone");
  localStorage.removeItem("gemix_custom_ringtone_name");
  showToast("Back to Gemix Ringtone");
};
window.playGemixSynthTone = function (kind) {
  try {
    if (!gemixAudioCtx) gemixAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = gemixAudioCtx;
    const now = ctx.currentTime;
    const notes = kind === "notification"
      ? [880, 1320]
      : kind === "caller"
        ? [523.25, 783.99, 1046.5, 1567.98]
        : [659.25, 987.77, 1318.51, 1975.53];
    notes.forEach((freq, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, now + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.25, now + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.18 + 0.35);
      o.connect(g);
      g.connect(ctx.destination);
      o.start(now + i * 0.18);
      o.stop(now + i * 0.18 + 0.4);
    });
  } catch (e) {}
};

let presenceHeartbeat = null;
let presenceUnsubscribes = {};

function gemixFormatLastSeen(ts) {
  if (!ts) return "Last seen recently";
  try {
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    const today = new Date();
    const isToday = d.toDateString() === today.toDateString();
    const timeStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (isToday) return "Last seen Today " + timeStr;
    return "Last seen " + d.toLocaleDateString() + " " + timeStr;
  } catch (e) {
    return "Last seen recently";
  }
}

async function gemixSetMyPresence(isOnline) {
  if (!myProfile || !myProfile.gemixNum) return;
  try {
    await setDoc(doc(db, "users", myProfile.gemixNum), {
      isOnline: isOnline,
      lastSeen: serverTimestamp(),
      inGemixApp: isOnline
    }, { merge: true });
  } catch (e) {}
}

window.startGemixPresence = function () {
  gemixSetMyPresence(true);
  if (presenceHeartbeat) clearInterval(presenceHeartbeat);
  presenceHeartbeat = setInterval(() => gemixSetMyPresence(true), 30000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) gemixSetMyPresence(false);
    else gemixSetMyPresence(true);
  });
  window.addEventListener("beforeunload", () => { gemixSetMyPresence(false); });
};

window.listenToPeerPresence = function (peerGemixId) {
  if (!peerGemixId) return;
  if (presenceUnsubscribes[peerGemixId]) presenceUnsubscribes[peerGemixId]();
  presenceUnsubscribes[peerGemixId] = onSnapshot(doc(db, "users", peerGemixId), (snap) => {
    if (!snap.exists()) return;
    const data = snap.data();
    const el = document.getElementById("chatUserStatus");
    if (el) {
      el.innerText = data.isOnline ? "In Gemix App" : gemixFormatLastSeen(data.lastSeen);
      el.style.color = data.isOnline ? "#2ecc71" : "#6c7382";
    }
    document.querySelectorAll(`[data-gemixid="${peerGemixId}"] .gemix-online-dot`).forEach((dot) => {
      dot.style.background = data.isOnline ? "#2ecc71" : "#c8ced8";
    });
  });
};
// ============ END PHASE 1 ============


// ============ PHASE 2: CALL SCREEN + PROXIMITY SENSOR + CUSTOM RINGTONE SETTINGS ============
(function () {
  if (document.getElementById("gemixPhase2Style")) return;
  const st = document.createElement("style");
  st.id = "gemixPhase2Style";
  st.textContent = `
  .gemix-call-screen{position:fixed;inset:0;z-index:999;background:linear-gradient(180deg,#0b1226,#16244d);display:none;flex-direction:column;align-items:center;justify-content:space-between;padding:48px 24px 36px;color:#fff;font-family:sans-serif}
  .gemix-call-screen.show{display:flex}
  .gemix-call-avatar{width:120px;height:120px;border-radius:50%;background:#edf1f8;color:#4285d4;display:grid;place-items:center;font-size:44px;font-weight:800;box-shadow:0 0 0 8px rgba(66,133,212,.25),0 0 40px rgba(66,133,212,.6);animation:gemixPulse 1.6s infinite}
  @keyframes gemixPulse{0%{box-shadow:0 0 0 0 rgba(66,133,212,.5)}100%{box-shadow:0 0 0 22px rgba(66,133,212,0)}}
  .gemix-call-btn{width:64px;height:64px;border-radius:50%;border:none;font-size:24px;cursor:pointer;display:grid;place-items:center}
  .gemix-proximity-overlay{position:fixed;inset:0;background:#000;z-index:1000;display:none}
  .gemix-proximity-overlay.on{display:block}
  .gemix-ringtone-modal{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1001;display:none;align-items:flex-end;justify-content:center}
  .gemix-ringtone-modal.show{display:flex}
  .gemix-ringtone-box{background:#edf1f8;width:100%;max-width:420px;border-radius:22px 22px 0 0;padding:20px}
  `;
  document.head.appendChild(st);
  if (!document.getElementById("gemixProximityOverlay")) {
    const o = document.createElement("div");
    o.id = "gemixProximityOverlay";
    o.className = "gemix-proximity-overlay";
    document.body.appendChild(o);
  }
})();

window.hideGemixCallScreen = function () {
  const el = document.getElementById("gemixCallScreen");
  if (el) el.classList.remove("show");
};
window.gemixAcceptFromCallScreen = function () {
  window.hideGemixCallScreen();
  if (typeof window.acceptIncomingCall === "function") window.acceptIncomingCall();
};
window.gemixDeclineFromCallScreen = function () {
  window.hideGemixCallScreen();
  if (typeof window.declineIncomingCall === "function") window.declineIncomingCall();
};

// ---- PROXIMITY SENSOR ----
let gemixProximitySensor = null;
let gemixProximityActive = false;

window.startGemixProximitySensor = function () {
  try {
    if ("ProximitySensor" in window) {
      gemixProximitySensor = new ProximitySensor({ frequency: 5 });
      gemixProximitySensor.addEventListener("reading", () => {
        const near = gemixProximitySensor.near;
        const ov = document.getElementById("gemixProximityOverlay");
        if (ov) ov.classList.toggle("on", !!near);
      });
      gemixProximitySensor.start();
      gemixProximityActive = true;
      return;
    }
  } catch (e) {}
  try {
    if ("ondeviceproximity" in window) {
      window.addEventListener("deviceproximity", (e) => {
        const ov = document.getElementById("gemixProximityOverlay");
        if (ov) ov.classList.toggle("on", e.near);
      });
      gemixProximityActive = true;
    }
  } catch (e) {}
};

window.stopGemixProximitySensor = function () {
  try {
    if (gemixProximitySensor) {
      gemixProximitySensor.stop();
      gemixProximitySensor = null;
    }
  } catch (e) {}
  const ov = document.getElementById("gemixProximityOverlay");
  if (ov) ov.classList.remove("on");
  gemixProximityActive = false;
};

window.addEventListener("gemix-proximity", (e) => {
  const near = e.detail && e.detail.near;
  const ov = document.getElementById("gemixProximityOverlay");
  if (ov) ov.classList.toggle("on", !!near);
});
window.gemixSetProximityNative = function (near) {
  const ov = document.getElementById("gemixProximityOverlay");
  if (ov) ov.classList.toggle("on", !!near);
};

// ---- CUSTOM RINGTONE SETTINGS UI ----
window.openGemixRingtoneSettings = function () {
  let m = document.getElementById("gemixRingtoneModal");
  if (!m) {
    m = document.createElement("div");
    m.id = "gemixRingtoneModal";
    m.className = "gemix-ringtone-modal";
    m.innerHTML = `
      <div class="gemix-ringtone-box">
        <div style="display:flex;justify-content:space-between;align-items:center"><h3 style="color:#222835">🔔 Ringtone Settings</h3><button onclick="closeGemixRingtoneSettings()" style="border:none;background:none;font-size:18px;cursor:pointer">✕</button></div>
        <p id="gemixCurrentRingtoneText" style="font-size:12px;color:#6c7382;margin:10px 0">Current: Gemix Ringtone (Futuristic)</p>
        <input type="file" id="gemixRingtoneFileInput" accept="audio/*" style="display:none" onchange="setGemixCustomRingtoneFromFile(event); updateGemixRingtoneLabel();">
        <button onclick="document.getElementById('gemixRingtoneFileInput').click()" style="width:100%;padding:14px;border-radius:14px;border:1.5px solid #d4af37;background:#fff;font-weight:700;cursor:pointer;margin-bottom:10px">📁 Select from Local Storage</button>
        <button onclick="if(typeof window.playGemixRingtone==='function') window.playGemixRingtone(); setTimeout(()=>{ if(typeof window.stopGemixRingtone==='function') window.stopGemixRingtone(); },2500)" style="width:100%;padding:14px;border-radius:14px;border:none;background:#4285d4;color:#fff;font-weight:700;cursor:pointer;margin-bottom:10px">▶ Preview Ringtone</button>
        <button onclick="if(typeof window.clearGemixCustomRingtone==='function') window.clearGemixCustomRingtone(); updateGemixRingtoneLabel();" style="width:100%;padding:14px;border-radius:14px;border:none;background:#edf1f8;font-weight:700;cursor:pointer">↩ Back to Gemix Ringtone</button>
      </div>`;
    document.body.appendChild(m);
    m.addEventListener("click", (e) => { if (e.target === m) closeGemixRingtoneSettings(); });
  }
  m.classList.add("show");
  updateGemixRingtoneLabel();
};
window.closeGemixRingtoneSettings = function () {
  const m = document.getElementById("gemixRingtoneModal");
  if (m) m.classList.remove("show");
};
window.updateGemixRingtoneLabel = function () {
  const el = document.getElementById("gemixCurrentRingtoneText");
  if (!el) return;
  const name = localStorage.getItem("gemix_custom_ringtone_name");
  el.innerText = name ? ("Current: Custom - " + name) : "Current: Gemix Ringtone (Futuristic)";
};
// ============ END PHASE 2 ============


// ============ PHASE 3: GROUP VIDEO AUTO-ADJUST + MASTER KEY RESTORE ============
(function () {
  if (document.getElementById("gemixPhase3Style")) return;
  const st = document.createElement("style");
  st.id = "gemixPhase3Style";
  st.textContent = `
  .gemix-group-video-grid{display:grid;gap:10px;width:100%;height:100%;padding:10px;box-sizing:border-box;grid-template-columns:1fr}
  .gemix-group-video-grid[data-count="1"]{grid-template-columns:1fr}
  .gemix-group-video-grid[data-count="2"]{grid-template-columns:1fr 1fr}
  .gemix-group-video-grid[data-count="3"],.gemix-group-video-grid[data-count="4"]{grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr}
  .gemix-group-video-grid[data-count="5"],.gemix-group-video-grid[data-count="6"]{grid-template-columns:1fr 1fr 1fr;grid-template-rows:1fr 1fr}
  @media (orientation:portrait) and (max-width:600px){
    .gemix-group-video-grid[data-count="2"],.gemix-group-video-grid[data-count="3"],.gemix-group-video-grid[data-count="4"]{grid-template-columns:1fr;grid-template-rows:repeat(auto-fit,minmax(0,1fr))}
    .gemix-group-video-grid[data-count="5"],.gemix-group-video-grid[data-count="6"]{grid-template-columns:1fr 1fr}
  }
  @media (min-width:900px){
    .gemix-group-video-grid[data-count="5"],.gemix-group-video-grid[data-count="6"]{grid-template-columns:1fr 1fr 1fr}
    .gemix-group-video-grid[data-count="7"],.gemix-group-video-grid[data-count="8"],.gemix-group-video-grid[data-count="9"]{grid-template-columns:1fr 1fr 1fr;grid-template-rows:1fr 1fr 1fr}
  }
  .gemix-video-tile{position:relative;background:#1a202c;border-radius:16px;overflow:hidden;min-height:0;display:flex;align-items:center;justify-content:center;border:1.5px solid #d4af37}
  .gemix-video-tile video{width:100%;height:100%;object-fit:cover;display:block}
  `;
  document.head.appendChild(st);
})();

window.gemixLayoutGroupVideo = function (containerId) {
  const container = document.getElementById(containerId || "videoInnerContainer");
  if (!container) return;
  container.classList.add("gemix-group-video-grid");
  const tiles = container.querySelectorAll("video, .gemix-video-tile, .selfie-pip-box");
  tiles.forEach((t) => {
    if (t.classList.contains("selfie-pip-box")) {
      t.style.position = "relative";
      t.style.width = "100%";
      t.style.height = "100%";
      t.style.bottom = "auto";
      t.style.right = "auto";
    }
  });
  container.setAttribute("data-count", String(tiles.length || 1));
};
window.addEventListener("resize", () => { window.gemixLayoutGroupVideo("videoInnerContainer"); });
window.addEventListener("orientationchange", () => { setTimeout(() => window.gemixLayoutGroupVideo("videoInnerContainer"), 300); });

async function gemixSha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function gemixKeyFromMaster(masterKey) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("GEMIX:" + masterKey));
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
async function gemixEncryptWithMaster(masterKey, plainObj) {
  const key = await gemixKeyFromMaster(masterKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(plainObj)));
  const combined = new Uint8Array(iv.length + enc.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(enc), iv.length);
  let bin = "";
  combined.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}
async function gemixDecryptWithMaster(masterKey, b64) {
  const key = await gemixKeyFromMaster(masterKey);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const iv = bytes.slice(0, 12);
  const data = bytes.slice(12);
  const dec = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return JSON.parse(new TextDecoder().decode(dec));
}

window.gemixBackupNow = async function () {
  if (!myProfile || !myProfile.gemixNum || !myProfile.masterKey) return;
  try {
    const payload = { profile: myProfile, contacts: contacts, backedUpAt: new Date().toISOString() };
    const encrypted = await gemixEncryptWithMaster(myProfile.masterKey, payload);
    const keyHash = await gemixSha256Hex("GEMIX-KEY:" + myProfile.masterKey);
    await setDoc(doc(db, "gemix_backups", myProfile.gemixNum), { encrypted, updatedAt: serverTimestamp() }, { merge: true });
    await setDoc(doc(db, "gemix_key_index", keyHash), { gemixNum: myProfile.gemixNum, updatedAt: serverTimestamp() }, { merge: true });
    localStorage.setItem("gemix_last_backup", new Date().toISOString());
  } catch (e) {
    console.error("Backup failed", e);
  }
};

window.gemixRestoreWithMasterKey = async function (masterKey) {
  if (!masterKey) {
    alert("Master Key podu machi!");
    return null;
  }
  try {
    showToast("Restoring your data...");
    const keyHash = await gemixSha256Hex("GEMIX-KEY:" + masterKey);
    const idxSnap = await getDoc(doc(db, "gemix_key_index", keyHash));
    if (!idxSnap.exists()) {
      alert("Itha Master Key ku backup illa machi!");
      return null;
    }
    const gemixNum = idxSnap.data().gemixNum;
    const bakSnap = await getDoc(doc(db, "gemix_backups", gemixNum));
    if (!bakSnap.exists()) {
      alert("Backup kedaikala!");
      return null;
    }
    const data = await gemixDecryptWithMaster(masterKey, bakSnap.data().encrypted);
    myProfile = data.profile;
    contacts = data.contacts || [];
    localStorage.setItem("gemix_vip_session", JSON.stringify(myProfile));
    for (const c of contacts) {
      try {
        await setDoc(doc(db, "users", myProfile.gemixNum, "contacts", c.gemixId), { ...c, createdAt: serverTimestamp() }, { merge: true });
      } catch (e) {}
    }
    applyProfileToUI(myProfile);
    startCloudListeners();
    if (typeof window.startGemixPresence === "function") window.startGemixPresence();
    document.getElementById("newUserLoginModal").classList.remove("open");
    showToast("Full Data Restored! Welcome back!");
    return data;
  } catch (e) {
    alert("Master Key thappu! Restore mudiyala.");
    return null;
  }
};

window.gemixTryRestoreFromLogin = function () {
  const key = document.getElementById("loginMasterKey").value.trim();
  if (!key) {
    alert("Master Key mattum podu machi, full data restore aagum!");
    return;
  }
  window.gemixRestoreWithMasterKey(key);
};
// ============ END PHASE 3 ============


// ============ LOGIN, SHOP REDIRECT & LICENSE AUTO-FILL ============
function applyLicenseSnapshotToInput(snap, expectedSuffix) {
  const currentSuffix = document.getElementById("loginUserIdSuffix")?.value.trim() || "";
  if (currentSuffix !== expectedSuffix) return;

  const numInput = document.getElementById("loginGemixNum");
  if (!numInput) return;

  if (snap && snap.exists()) {
    const data = snap.data();
    const rawNum = data.gemixNum != null ? String(data.gemixNum).trim() : "";
    const status = String(data.status || "").toLowerCase();

    if (status === "active" && /^\d{5}$/.test(rawNum)) {
      const wasEmpty = numInput.value !== rawNum;
      numInput.value = rawNum;
      const errEl = document.getElementById("loginError");
      if (errEl) errEl.style.display = "none";
      if (wasEmpty) {
        showToast("5-Digit Gemix Number Activated!");
      }
      return;
    }
  }
  numInput.value = "";
}

// Real-time + on-resume auto-fill of 5-digit Gemix Number when activated from Activation Centre
window.watchLicenseAutoFill = async function (forceRefresh = false) {
  const suffixEl = document.getElementById("loginUserIdSuffix");
  const numInput = document.getElementById("loginGemixNum");
  if (!suffixEl || !numInput) return;

  const suffix = suffixEl.value.trim();
  if (!suffix) {
    watchedLicenseSuffix = "";
    if (unsubscribeLicenseListener) {
      unsubscribeLicenseListener();
      unsubscribeLicenseListener = null;
    }
    numInput.value = "";
    return;
  }

  const fullUserId = "G_" + suffix;
  const licenseRef = doc(db, "licenses", fullUserId);

  // Immediate fetch (essential when returning from Shop browser in Android WebView)
  if (forceRefresh || watchedLicenseSuffix !== suffix) {
    try {
      const immediateSnap = await getDoc(licenseRef);
      applyLicenseSnapshotToInput(immediateSnap, suffix);
    } catch (e) {}
  }

  if (watchedLicenseSuffix === suffix && unsubscribeLicenseListener) {
    return;
  }

  watchedLicenseSuffix = suffix;
  if (unsubscribeLicenseListener) {
    unsubscribeLicenseListener();
    unsubscribeLicenseListener = null;
  }

  unsubscribeLicenseListener = onSnapshot(licenseRef, (snap) => {
    applyLicenseSnapshotToInput(snap, suffix);
  });
};

window.addEventListener("DOMContentLoaded", () => {
  const suffixInput = document.getElementById("loginUserIdSuffix");
  if (suffixInput) {
    suffixInput.addEventListener("input", () => window.watchLicenseAutoFill(false));
    suffixInput.addEventListener("change", () => window.watchLicenseAutoFill(true));
  }

  const draftLogin = localStorage.getItem("gemix_pending_login");
  const savedSession = localStorage.getItem("gemix_vip_session");

  if (savedSession) {
    myProfile = JSON.parse(savedSession);
    applyProfileToUI(myProfile);
    startCloudListeners();
    if (typeof window.startGemixPresence === "function") window.startGemixPresence();
    monitorActiveSessionLicense(myProfile.userId);
  } else {
    if (draftLogin) {
      try {
        const d = JSON.parse(draftLogin);
        if (d.name) document.getElementById("loginName").value = d.name;
        if (d.userId) document.getElementById("loginUserIdSuffix").value = d.userId.replace(/^G_/, "");
        if (d.masterKey) document.getElementById("loginMasterKey").value = d.masterKey;
        if (d.avatarUrl) {
          tempAvatarDataUrl = d.avatarUrl;
          document.getElementById("pickerPreviewBox").innerHTML = `<img src="${tempAvatarDataUrl}" alt="Avatar">`;
        }
        window.watchLicenseAutoFill(true);
      } catch (e) {}
    }
    document.getElementById("newUserLoginModal").classList.add("open");
  }

  // Capacitor native app resume listener (triggers auto-fill right after closing Shop browser)
  try {
    const capApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (capApp && typeof capApp.addListener === "function") {
      capApp.addListener("appStateChange", ({ isActive }) => {
        if (isActive && !localStorage.getItem("gemix_vip_session")) {
          window.watchLicenseAutoFill(true);
        }
      });
    }
  } catch (e) {}
});

// Web / Android WebView visibility & focus resume check for instant auto-fill
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !localStorage.getItem("gemix_vip_session")) {
    window.watchLicenseAutoFill(true);
  }
});
window.addEventListener("focus", () => {
  if (!localStorage.getItem("gemix_vip_session")) {
    window.watchLicenseAutoFill(true);
  }
});

// Monitor live license status while logged in
function monitorActiveSessionLicense(userId) {
  if (!userId) return;
  const licenseRef = doc(db, "licenses", userId);
  onSnapshot(licenseRef, (snap) => {
    if (snap.exists() && String(snap.data().status || "").toLowerCase() === "inactive") {
      localStorage.removeItem("gemix_vip_session");
      alert("Your VIP Gemix Number has been deactivated by Activation Centre.");
      location.reload();
    }
  });
}

// Cart button click -> safe native/web redirect to Gemix Shop
async function openGemixShopUrl(shopUrl) {
  try {
    const capBrowser = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser;
    if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform() && capBrowser && typeof capBrowser.open === "function") {
      await capBrowser.open({ url: shopUrl });
      return;
    }
  } catch (e) {}

  try {
    const { Browser } = await import("https://esm.sh/@capacitor/browser@6");
    if (Browser && typeof Browser.open === "function") {
      await Browser.open({ url: shopUrl });
      return;
    }
  } catch (e) {}

  const win = window.open(shopUrl, "_blank", "noopener,noreferrer");
  if (!win) {
    window.location.href = shopUrl;
  }
}

window.goToGemixShop = async function () {
  const name = document.getElementById("loginName").value.trim();
  const suffix = document.getElementById("loginUserIdSuffix").value.trim();
  const masterKey = document.getElementById("loginMasterKey").value.trim();
  const errorEl = document.getElementById("loginError");

  if (!name || !suffix || !masterKey) {
    errorEl.innerText = "Fill Name, User ID & Master Key first before opening the Shop!";
    errorEl.style.display = "block";
    return;
  }

  errorEl.style.display = "none";
  const fullUserId = "G_" + suffix;

  localStorage.setItem("gemix_pending_login", JSON.stringify({
    name,
    userId: fullUserId,
    masterKey,
    avatarUrl: tempAvatarDataUrl || myProfile.avatarUrl || ""
  }));

  // Ensure live listener is attached before leaving for Shop
  window.watchLicenseAutoFill(true);

  const shopUrl = `https://gemix-shop.web.app/?name=${encodeURIComponent(name)}&userId=${encodeURIComponent(fullUserId)}`;
  await openGemixShopUrl(shopUrl);
};

function applyProfileToUI(profile) {
  document.getElementById("displayProfileName").innerText = profile.name;
  const avatarBox = document.getElementById("myProfileAvatarBox");
  if (profile.avatarUrl) {
    avatarBox.innerHTML = `<img src="${profile.avatarUrl}" alt="Avatar">`;
  } else {
    avatarBox.innerText = profile.name.charAt(0).toUpperCase();
  }
  document.getElementById("displayUserId").innerText = profile.userId;
  document.getElementById("displayGemixNum").innerText = profile.gemixNum;
  document.getElementById("displayMasterKey").innerText = "*".repeat(profile.masterKey.length);
}

// Smart image compressor for instant Firestore sync
function compressImageToBase64(file, maxWidth = 720, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let width = img.width;
        let height = img.height;
        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
    };
    reader.onerror = reject;
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result);
    reader.onerror = (error) => reject(error);
  });
}

window.previewLoginAvatar = async function (event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    tempAvatarDataUrl = await compressImageToBase64(file, 220, 0.75);
    document.getElementById("pickerPreviewBox").innerHTML = `<img src="${tempAvatarDataUrl}" alt="Avatar">`;
  } catch (e) {}
};

window.openLoginModal = function () {
  document.getElementById("loginError").style.display = "none";
  if (myProfile.name) {
    document.getElementById("loginName").value = myProfile.name;
    document.getElementById("loginGemixNum").value = myProfile.gemixNum;
    document.getElementById("loginUserIdSuffix").value = myProfile.userId.replace(/^G_/, "");
    document.getElementById("loginMasterKey").value = myProfile.masterKey;
    if (myProfile.avatarUrl) {
      tempAvatarDataUrl = myProfile.avatarUrl;
      document.getElementById("pickerPreviewBox").innerHTML = `<img src="${tempAvatarDataUrl}" alt="Avatar">`;
    }
    window.watchLicenseAutoFill(true);
  }
  document.getElementById("newUserLoginModal").classList.add("open");
};

window.completeUserLogin = async function () {
  const name = document.getElementById("loginName").value.trim();
  const gemixNum = document.getElementById("loginGemixNum").value.trim();
  const userIdSuffix = document.getElementById("loginUserIdSuffix").value.trim();
  const masterKey = document.getElementById("loginMasterKey").value.trim();
  const errorEl = document.getElementById("loginError");
  const submitBtn = document.getElementById("loginSubmitBtn");

  if (!name || !userIdSuffix || !masterKey) {
    errorEl.innerText = "Please fill Name, User ID & Master Key!";
    errorEl.style.display = "block";
    return;
  }

  if (!/^\d{5}$/.test(gemixNum)) {
    errorEl.innerText = "Gemix Number is locked! Tap the cart icon to buy & activate your 5-digit number.";
    errorEl.style.display = "block";
    return;
  }

  submitBtn.disabled = true;
  submitBtn.innerText = "Verifying License...";

  const fullUserId = "G_" + userIdSuffix;

  try {
    const licenseSnap = await getDoc(doc(db, "licenses", fullUserId));
    const licData = licenseSnap.exists() ? licenseSnap.data() : null;
    if (
      !licData ||
      String(licData.status || "").toLowerCase() !== "active" ||
      String(licData.gemixNum || "").trim() !== gemixNum
    ) {
      errorEl.innerText = "Number not active for this User ID! Complete activation in Shop.";
      errorEl.style.display = "block";
      submitBtn.disabled = false;
      submitBtn.innerText = "Enter Gemix Connect";
      return;
    }

    const finalAvatar = tempAvatarDataUrl || myProfile.avatarUrl || "";
    myProfile = { name, gemixNum, userId: fullUserId, masterKey, avatarUrl: finalAvatar };

    await setDoc(doc(db, "users", gemixNum), {
      ...myProfile,
      online: true,
      updatedAt: serverTimestamp()
    }, { merge: true });

    localStorage.setItem("gemix_vip_session", JSON.stringify(myProfile));
    localStorage.removeItem("gemix_pending_login");
    applyProfileToUI(myProfile);
    startCloudListeners();
    if (typeof window.startGemixPresence === "function") window.startGemixPresence();
    if (typeof window.gemixBackupNow === "function") window.gemixBackupNow();
    monitorActiveSessionLicense(fullUserId);

    document.getElementById("newUserLoginModal").classList.remove("open");
  } catch (err) {
    errorEl.innerText = "Connection error! Please try again.";
    errorEl.style.display = "block";
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerText = "Enter Gemix Connect";
  }
};

function startCloudListeners() {
  if (!myProfile.gemixNum) return;

  const contactsRef = collection(db, "users", myProfile.gemixNum, "contacts");
  onSnapshot(contactsRef, (snapshot) => {
    contacts = [];
    snapshot.forEach((docSnap) => {
      contacts.push({ id: docSnap.id, ...docSnap.data() });
    });
    renderAllLists();
  });

  const myCallRef = doc(db, "calls", myProfile.gemixNum);
  if (unsubscribeIncomingCall) unsubscribeIncomingCall();
  unsubscribeIncomingCall = onSnapshot(myCallRef, async (docSnap) => {
    if (docSnap.exists()) {
      const callData = docSnap.data();
      if (callData.status === "ringing" && callData.callerGemixNum !== myProfile.gemixNum) {
        incomingCallData = callData;
        document.getElementById("incomingCallerName").innerText = callData.callerName;
        document.getElementById("incomingCallType").innerText = callData.isVideo ? "VIP Video Call" : "VIP Voice Call";
        document.getElementById("incomingCallBanner").classList.add("show");
        if (typeof window.showGemixCallScreen === "function") window.showGemixCallScreen(callData.callerName, callData.isVideo, true);
        if (typeof window.playGemixRingtone === "function") window.playGemixRingtone();
      } else {
        document.getElementById("incomingCallBanner").classList.remove("show");
      }
    } else {
      document.getElementById("incomingCallBanner").classList.remove("show");
    }
  });
}

window.openAddContactModal = function () {
  document.getElementById("addContactModal").classList.add("open");
  document.getElementById("idError").style.display = "none";
};

window.closeAddContactModal = function () {
  document.getElementById("addContactModal").classList.remove("open");
};

window.saveNewContact = async function () {
  const nameInput = document.getElementById("contactName");
  const idInput = document.getElementById("contactGemixId");
  const noteInput = document.getElementById("contactNote");
  const errorMsg = document.getElementById("idError");
  const saveBtn = document.getElementById("saveContactBtn");

  const name = nameInput.value.trim();
  const gemixId = idInput.value.trim();
  const note = noteInput.value.trim();

  if (!name || gemixId.length !== 5) {
    errorMsg.innerText = !name ? "Please enter a VIP Name!" : "Gemix Number must be exact 5 digits!";
    errorMsg.style.display = "block";
    return;
  }

  saveBtn.disabled = true;
  saveBtn.innerText = "Saving...";

  try {
    const userDocRef = doc(db, "users", gemixId);
    const userSnap = await getDoc(userDocRef);

    let avatarUrl = "";
    if (userSnap.exists()) {
      avatarUrl = userSnap.data().avatarUrl || "";
    }

    const newContact = {
      name,
      gemixId,
      note,
      avatarUrl,
      initial: name.charAt(0).toUpperCase(),
      createdAt: serverTimestamp()
    };

    await setDoc(doc(db, "users", myProfile.gemixNum, "contacts", gemixId), newContact);

    nameInput.value = "";
    idInput.value = "";
    noteInput.value = "";
    if (typeof window.closeAddContactModal === "function") window.closeAddContactModal();
    if (typeof window.switchScreen === "function") window.switchScreen("chat-screen", document.getElementById("tab-chat"));
  } catch (err) {
    errorMsg.innerText = "Cloud sync failed!";
    errorMsg.style.display = "block";
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerText = "Save Contact";
  }
};

window.renderAllLists = function () {
  const chatList = document.getElementById("chatList");
  const callList = document.getElementById("callList");
  const videoList = document.getElementById("videoList");
  const groupListArea = document.getElementById("groupListArea");

  if (!chatList || !callList || !videoList || !groupListArea) return;
  if (contacts.length === 0) return;

  chatList.innerHTML = "";
  callList.innerHTML = "";
  videoList.innerHTML = "";
  groupListArea.innerHTML = "";

  contacts.forEach((c) => {
    const safeName = c.name.replace(/'/g, "\\'");
    const safeNote = c.note ? c.note.replace(/'/g, "\\'") : "";
    const subtext = c.note ? c.note : "Tap to message";
    const avatarContent = c.avatarUrl ? `<img src="${c.avatarUrl}" alt="Avatar">` : c.initial;

    chatList.innerHTML += `
      <div class="neumo-card" onclick="openChat('${safeName}', '${c.gemixId}', '${c.initial}', '${safeNote}')">
        <div class="card-info">
          <div class="avatar">${avatarContent}</div>
          <div class="card-text">
            <h4>${c.name}</h4>
            <p>${subtext}</p>
          </div>
        </div>
        <span style="font-size:12px; color:#4285d4; font-weight:bold;">Open</span>
      </div>
    `;

    callList.innerHTML += `
      <div class="neumo-card" onclick="initiateWebRTCCall('${safeName}', '${c.gemixId}', false)">
        <div class="card-info">
          <div class="avatar">${avatarContent}</div>
          <div class="card-text">
            <h4>${c.name}</h4>
            <p>${c.note ? c.note : "Voice Call"}</p>
          </div>
        </div>
        <button class="action-icon">Call</button>
      </div>
    `;

    videoList.innerHTML += `
      <div class="neumo-card" onclick="initiateWebRTCCall('${safeName}', '${c.gemixId}', true)">
        <div class="card-info">
          <div class="avatar">${avatarContent}</div>
          <div class="card-text">
            <h4>${c.name}</h4>
            <p>${c.note ? c.note : "Video Call"}</p>
          </div>
        </div>
        <button class="action-icon">Video</button>
      </div>
    `;

    groupListArea.innerHTML += `
      <div class="neumo-card group-item" onclick="handleGroupCardClick(this, '${safeName}')">
        <div class="card-info">
          <div class="avatar">${avatarContent}</div>
          <div class="card-text">
            <h4>${c.name}</h4>
            <p>${c.note ? c.note : "VIP Contact"}</p>
          </div>
        </div>
        <input type="checkbox" class="group-checkbox" value="${c.name}">
      </div>
    `;
  });
};

window.openChat = function (name, gemixId, avatarText, note) {
  if (typeof window.listenToPeerPresence === "function") window.listenToPeerPresence(gemixId);
  const contactObj = contacts.find((c) => c.gemixId === gemixId);
  const avatarUrl = contactObj ? contactObj.avatarUrl : "";
  window.activeChatPeer = { name, gemixId, initial: avatarText, note, avatarUrl };
  enterFullScreenView("active-chat-screen");

  document.getElementById("chatUserName").innerText = name;
  const avatarBox = document.getElementById("chatAvatar");
  if (avatarUrl) {
    avatarBox.innerHTML = `<img src="${avatarUrl}" alt="Avatar">`;
  } else {
    avatarBox.innerText = avatarText;
  }

  const box = document.getElementById("messagesBox");
  box.innerHTML = note ? `<div class="note-banner">Note: ${escapeHtml(note)}</div>` : "";
  resetInputBar();

  const chatId = [myProfile.gemixNum, gemixId].sort().join("_");
  const messagesRef = collection(db, "chats", chatId, "messages");
  const q = query(messagesRef, orderBy("createdAt", "asc"));

  if (unsubscribeChatListener) unsubscribeChatListener();

  unsubscribeChatListener = onSnapshot(q, (snapshot) => {
    snapshot.docChanges().forEach((chg) => {
      if (chg.type === "added" && chg.doc.data().senderGemixNum !== myProfile.gemixNum) {
        if (typeof window.playGemixNotification === "function") window.playGemixNotification();
      }
    });
    currentMessagesMap = {};
    box.innerHTML = note ? `<div class="note-banner">Note: ${escapeHtml(note)}</div>` : "";
    snapshot.forEach((docSnap) => {
      const msgData = { id: docSnap.id, chatId, ...docSnap.data() };
      currentMessagesMap[docSnap.id] = msgData;
      appendMessageBubble(msgData);
    });
    box.scrollTop = box.scrollHeight;
  });
};

function appendMessageBubble(msg) {
  const box = document.getElementById("messagesBox");
  const isSent = msg.senderGemixNum === myProfile.gemixNum;
  const msgClass = isSent ? "msg sent" : "msg received";
  const forwardedBadge = msg.forwarded ? `<div class="forwarded-tag">Forwarded</div>` : "";

  let contentHTML = "";
  if (msg.type === "text") {
    contentHTML = `${forwardedBadge}<div>${escapeHtml(msg.text)}</div>`;
  } else if (msg.type === "image") {
    contentHTML = `
      ${forwardedBadge}
      <img src="${msg.fileUrl}" class="chat-media" alt="Media" onclick="openLightbox('image', '${msg.fileUrl}', '${escapeHtml(msg.fileName || "Image")}')">
      ${msg.caption ? `<div style="margin-top:4px; font-size:14px;">${escapeHtml(msg.caption)}</div>` : ""}
    `;
  } else if (msg.type === "video") {
    contentHTML = `
      ${forwardedBadge}
      <video src="${msg.fileUrl}" controls style="max-width:100%; max-height:190px; border-radius:10px; display:block; margin-bottom:6px;"></video>
      ${msg.caption ? `<div style="margin-top:4px; font-size:14px;">${escapeHtml(msg.caption)}</div>` : ""}
    `;
  } else if (msg.type === "audio") {
    const uniqueId = "audio_" + Math.random().toString(36).substring(2);
    contentHTML = `
      ${forwardedBadge}
      <div class="voice-bubble">
        <button class="play-voice-btn" onclick="playVoice('${uniqueId}', this)">Play</button>
        <div>
          <div style="font-size:12px; font-weight:bold;">Voice Note</div>
          <div style="font-size:11px; opacity:0.85;">${msg.duration || "0:00"}</div>
        </div>
      </div>
      <audio id="${uniqueId}" src="${msg.fileUrl}"></audio>
    `;
  } else {
    const isPdf = (msg.fileName || "").toLowerCase().endsWith(".pdf");
    contentHTML = `
      ${forwardedBadge}
      <div class="file-attachment" onclick="openLightbox('${isPdf ? "pdf" : "doc"}', '${msg.fileUrl}', '${escapeHtml(msg.fileName || "Document")}')">
        <span style="font-size:24px;">${isPdf ? "PDF" : "DOC"}</span>
        <div>
          <div style="font-size:13px; font-weight:bold;">${escapeHtml(msg.fileName || "Document")}</div>
          <div style="font-size:11px; opacity:0.85;">Tap to view/download</div>
        </div>
      </div>
      ${msg.caption ? `<div style="margin-top:4px; font-size:14px;">${escapeHtml(msg.caption)}</div>` : ""}
    `;
  }

  const div = document.createElement("div");
  div.className = msgClass;
  div.innerHTML = contentHTML;

  const startPress = () => {
    div.classList.add("pressing");
    longPressTimer = setTimeout(() => {
      div.classList.remove("pressing");
      if (navigator.vibrate) navigator.vibrate(40);
      openMsgActionModal(msg.id);
    }, 500);
  };
  const cancelPress = () => {
    div.classList.remove("pressing");
    clearTimeout(longPressTimer);
  };

  div.addEventListener("touchstart", startPress, { passive: true });
  div.addEventListener("touchend", cancelPress);
  div.addEventListener("touchmove", cancelPress);
  div.addEventListener("mousedown", startPress);
  div.addEventListener("mouseup", cancelPress);
  div.addEventListener("mouseleave", cancelPress);
  div.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    cancelPress();
    openMsgActionModal(msg.id);
  });

  box.appendChild(div);
}

// Long-press message action modal
window.openMsgActionModal = function (msgId) {
  const msg = currentMessagesMap[msgId];
  if (!msg) return;
  selectedLongPressMsg = msg;

  const copyBtn = document.getElementById("copyMsgActionBtn");
  const downloadBtn = document.getElementById("downloadMsgActionBtn");

  copyBtn.style.display = (msg.text || msg.caption) ? "flex" : "none";
  downloadBtn.style.display = msg.fileUrl ? "flex" : "none";

  document.getElementById("msgActionModalTitle").innerText = "Message Options";
  document.getElementById("msgActionMainMenu").style.display = "flex";
  document.getElementById("forwardFriendsPanel").style.display = "none";
  document.getElementById("msgActionModal").classList.add("open");
};

window.closeMsgActionModal = function () {
  document.getElementById("msgActionModal").classList.remove("open");
  selectedLongPressMsg = null;
};

window.copySelectedMessage = async function () {
  if (!selectedLongPressMsg) return;
  const textToCopy = selectedLongPressMsg.text || selectedLongPressMsg.caption || "";
  if (!textToCopy) return;

  try {
    await navigator.clipboard.writeText(textToCopy);
    showToast("Copied to clipboard!");
  } catch (err) {
    const ta = document.createElement("textarea");
    ta.value = textToCopy;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    showToast("Copied to clipboard!");
  }
  closeMsgActionModal();
};

window.downloadSelectedMedia = function () {
  if (!selectedLongPressMsg || !selectedLongPressMsg.fileUrl) return;

  const url = selectedLongPressMsg.fileUrl;
  let defaultExt = "bin";
  if (selectedLongPressMsg.type === "image") defaultExt = "jpg";
  else if (selectedLongPressMsg.type === "video") defaultExt = "mp4";
  else if (selectedLongPressMsg.type === "audio") defaultExt = "webm";

  const fileName = selectedLongPressMsg.fileName || `gemix_${selectedLongPressMsg.type}_${Date.now()}.${defaultExt}`;

  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.target = "_blank";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  showToast("Downloading...");
  closeMsgActionModal();
};

window.backToActionMenu = function () {
  document.getElementById("msgActionModalTitle").innerText = "Message Options";
  document.getElementById("msgActionMainMenu").style.display = "flex";
  document.getElementById("forwardFriendsPanel").style.display = "none";
};

window.openForwardFriendsList = function () {
  if (contacts.length === 0) {
    alert("No contacts available to share with!");
    return;
  }
  document.getElementById("msgActionModalTitle").innerText = "Share to Friends";
  document.getElementById("msgActionMainMenu").style.display = "none";
  document.getElementById("forwardFriendsPanel").style.display = "flex";

  const container = document.getElementById("shareFriendsListContainer");
  container.innerHTML = "";

  contacts.forEach((c) => {
    const avatarContent = c.avatarUrl ? `<img src="${c.avatarUrl}" alt="Avatar">` : c.initial;
    container.innerHTML += `
      <label class="share-friend-row">
        <div style="display:flex; align-items:center; gap:10px;">
          <div class="avatar" style="width:36px; height:36px; font-size:14px;">${avatarContent}</div>
          <span style="font-size:14px; font-weight:700; color:#222835;">${c.name}</span>
        </div>
        <input type="checkbox" class="share-friend-checkbox" value="${c.gemixId}" style="width:20px; height:20px; accent-color:#4285d4;">
      </label>
    `;
  });
};

window.executeForwardMessage = async function () {
  if (!selectedLongPressMsg) return;
  const checked = document.querySelectorAll(".share-friend-checkbox:checked");
  if (checked.length === 0) {
    alert("Please select at least one friend to share!");
    return;
  }

  const btn = document.getElementById("confirmForwardBtn");
  btn.disabled = true;
  btn.innerText = "Sharing...";

  try {
    const payload = {
      senderGemixNum: myProfile.gemixNum,
      senderName: myProfile.name,
      type: selectedLongPressMsg.type,
      forwarded: true,
      createdAt: serverTimestamp()
    };

    if (selectedLongPressMsg.text) payload.text = selectedLongPressMsg.text;
    if (selectedLongPressMsg.fileUrl) payload.fileUrl = selectedLongPressMsg.fileUrl;
    if (selectedLongPressMsg.fileName) payload.fileName = selectedLongPressMsg.fileName;
    if (selectedLongPressMsg.caption) payload.caption = selectedLongPressMsg.caption;
    if (selectedLongPressMsg.duration) payload.duration = selectedLongPressMsg.duration;

    for (const cb of checked) {
      const targetGemixId = cb.value;
      const targetChatId = [myProfile.gemixNum, targetGemixId].sort().join("_");
      await addDoc(collection(db, "chats", targetChatId, "messages"), payload);
    }

    showToast("Shared with selected friends!");
    closeMsgActionModal();
  } catch (err) {
    alert("Failed to forward message!");
  } finally {
    btn.disabled = false;
    btn.innerText = "Share Now";
  }
};

window.deleteSelectedMessage = async function () {
  if (!selectedLongPressMsg) return;
  const { chatId, id } = selectedLongPressMsg;
  closeMsgActionModal();

  try {
    await deleteDoc(doc(db, "chats", chatId, "messages", id));
    showToast("Message deleted");
  } catch (err) {
    alert("Could not delete message!");
  }
};

window.toggleActionBtn = function () {
  const text = document.getElementById("msgInput").value.trim();
  const btn = document.getElementById("mainActionBtn");
  if (text.length > 0) {
    btn.innerText = "Send";
  } else if (!isRecording && !isRecordedReady) {
    btn.innerText = "🎙️";
  }
};

window.handleMainAction = function () {
  const text = document.getElementById("msgInput").value.trim();
  if (text.length > 0) {
    sendMessage();
  } else if (!isRecording && !isRecordedReady) {
    startVoiceNote();
  } else if (isRecording) {
    stopVoiceRecordingAndPreview();
  } else if (isRecordedReady) {
    sendRecordedVoiceNote();
  }
};

window.sendMessage = async function () {
  const input = document.getElementById("msgInput");
  const text = input.value.trim();
  if (!text || !window.activeChatPeer.gemixId) return;

  const chatId = [myProfile.gemixNum, window.activeChatPeer.gemixId].sort().join("_");
  input.value = "";
  toggleActionBtn();

  try {
    await addDoc(collection(db, "chats", chatId, "messages"), {
      senderGemixNum: myProfile.gemixNum,
      senderName: myProfile.name,
      type: "text",
      text,
      createdAt: serverTimestamp()
    });
  } catch (err) {}
};

// Voice note record, preview & cloud sync
window.startVoiceNote = async function () {
  isRecording = true;
  isRecordedReady = false;
  recSeconds = 0;
  audioChunks = [];

  document.getElementById("msgInput").style.display = "none";
  document.getElementById("attachBtn").style.display = "none";
  document.getElementById("recStateIndicator").style.display = "flex";
  document.getElementById("previewAudioControls").style.display = "none";
  document.getElementById("recordingBar").style.display = "flex";
  document.getElementById("mainActionBtn").innerText = "Stop";
  document.getElementById("recTimer").innerText = "0:00";
  document.getElementById("recDot").style.display = "inline-block";
  document.getElementById("recStateText").innerText = "Recording";
  document.getElementById("recStateText").style.color = "#ff4b5c";

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) audioChunks.push(e.data);
    };
    mediaRecorder.start();
  } catch (err) {
    mediaRecorder = null;
    alert("Microphone permission needed for voice notes!");
    resetInputBar();
    return;
  }

  recInterval = setInterval(() => {
    recSeconds++;
    const mins = Math.floor(recSeconds / 60);
    const secs = recSeconds % 60;
    document.getElementById("recTimer").innerText = `${mins}:${secs < 10 ? "0" : ""}${secs}`;
  }, 1000);
};

window.stopVoiceRecordingAndPreview = function () {
  clearInterval(recInterval);
  isRecording = false;
  isRecordedReady = true;

  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.onstop = () => {
      recordedAudioBlob = new Blob(audioChunks, { type: "audio/webm" });
      recordedAudioUrl = URL.createObjectURL(recordedAudioBlob);
      previewAudioElement = new Audio(recordedAudioUrl);
    };
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach((t) => t.stop());
  }

  document.getElementById("recStateIndicator").style.display = "none";
  document.getElementById("previewAudioControls").style.display = "flex";
  document.getElementById("mainActionBtn").innerText = "Send";
};

window.togglePreviewPlayback = function () {
  const playBtn = document.getElementById("previewPlayBtn");
  const statusText = document.getElementById("previewStatus");
  if (previewAudioElement) {
    if (previewAudioElement.paused) {
      previewAudioElement.play();
      playBtn.innerText = "Pause";
      statusText.innerText = "Playing review...";
      previewAudioElement.onended = () => {
        playBtn.innerText = "Play";
        statusText.innerText = "Tap to preview";
      };
    } else {
      previewAudioElement.pause();
      playBtn.innerText = "Play";
      statusText.innerText = "Paused";
    }
  }
};

window.cancelVoiceNote = function () {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach((t) => t.stop());
  }
  if (previewAudioElement) {
    previewAudioElement.pause();
    previewAudioElement = null;
  }
  recordedAudioBlob = null;
  resetInputBar();
};

window.sendRecordedVoiceNote = async function () {
  const duration = document.getElementById("recTimer").innerText;
  const actionBtn = document.getElementById("mainActionBtn");
  actionBtn.disabled = true;
  actionBtn.innerText = "...";

  if (recordedAudioBlob && window.activeChatPeer.gemixId) {
    try {
      const audioDataUrl = await fileToBase64(recordedAudioBlob);
      const chatId = [myProfile.gemixNum, window.activeChatPeer.gemixId].sort().join("_");
      await addDoc(collection(db, "chats", chatId, "messages"), {
        senderGemixNum: myProfile.gemixNum,
        senderName: myProfile.name,
        type: "audio",
        fileUrl: audioDataUrl,
        duration,
        createdAt: serverTimestamp()
      });
    } catch (err) {
      alert("Voice note too long! Keep under 45 seconds.");
    }
  }

  actionBtn.disabled = false;
  recordedAudioBlob = null;
  resetInputBar();
};

window.playVoice = function (audioId, btn) {
  const audio = document.getElementById(audioId);
  if (audio) {
    if (audio.paused) {
      audio.play();
      btn.innerText = "Pause";
      audio.onended = () => { btn.innerText = "Play"; };
    } else {
      audio.pause();
      btn.innerText = "Play";
    }
  }
};

function resetInputBar() {
  isRecording = false;
  isRecordedReady = false;
  clearInterval(recInterval);
  if (previewAudioElement) {
    previewAudioElement.pause();
    previewAudioElement = null;
  }
  document.getElementById("msgInput").style.display = "block";
  document.getElementById("attachBtn").style.display = "grid";
  document.getElementById("recordingBar").style.display = "none";
  document.getElementById("mainActionBtn").innerText = "🎙️";
}

// Media & file preview + cloud sync
window.openMediaPreviewModal = function (event) {
  const file = event.target.files[0];
  if (!file) return;

  pendingMediaFile = file;
  pendingMediaUrl = URL.createObjectURL(file);

  const stage = document.getElementById("mediaPreviewStage");
  const title = document.getElementById("previewModalTitle");
  const sizeKB = (file.size / 1024).toFixed(1) + " KB";

  document.getElementById("mediaCaptionInput").value = "";

  if (file.type.startsWith("image/")) {
    title.innerText = "Image Preview";
    stage.innerHTML = `<img src="${pendingMediaUrl}" alt="Preview">`;
  } else if (file.type.startsWith("video/")) {
    title.innerText = "Video Preview";
    stage.innerHTML = `<video src="${pendingMediaUrl}" controls autoplay muted></video>`;
  } else if (file.type === "application/pdf") {
    title.innerText = "PDF Document Preview";
    stage.innerHTML = `
      <iframe src="${pendingMediaUrl}" style="width:100%; height:240px; border:none; border-radius:12px;"></iframe>
      <div style="font-size:12px; font-weight:700; color:#222835; margin-top:6px;">${file.name} (${sizeKB})</div>
    `;
  } else {
    title.innerText = "Document Preview";
    const ext = file.name.split(".").pop().toUpperCase();
    stage.innerHTML = `
      <div class="doc-preview-card">
        <div class="doc-preview-icon">DOC</div>
        <div style="font-size:14px; font-weight:700; color:#222835; word-break:break-all;">${file.name}</div>
        <div style="font-size:12px; color:#6c7382;">${ext} Document - ${sizeKB}</div>
      </div>
    `;
  }

  document.getElementById("mediaPreviewModal").classList.add("open");
  event.target.value = "";
};

window.closeMediaPreviewModal = function () {
  document.getElementById("mediaPreviewModal").classList.remove("open");
  pendingMediaFile = null;
  pendingMediaUrl = null;
};

window.confirmSendMedia = async function () {
  if (!pendingMediaFile || !window.activeChatPeer.gemixId) return;

  const caption = document.getElementById("mediaCaptionInput").value.trim();
  const confirmBtn = document.getElementById("confirmMediaBtn");
  confirmBtn.disabled = true;
  confirmBtn.innerText = "...";

  try {
    const chatId = [myProfile.gemixNum, window.activeChatPeer.gemixId].sort().join("_");
    let type = "doc";
    let finalFileUrl = "";

    if (pendingMediaFile.type.startsWith("image/")) {
      type = "image";
      finalFileUrl = await compressImageToBase64(pendingMediaFile, 800, 0.72);
    } else if (pendingMediaFile.type.startsWith("video/")) {
      type = "video";
      if (pendingMediaFile.size <= 750 * 1024) {
        finalFileUrl = await fileToBase64(pendingMediaFile);
      } else {
        finalFileUrl = await uploadWithTimeout(pendingMediaFile);
      }
    } else {
      type = "doc";
      if (pendingMediaFile.size <= 750 * 1024) {
        finalFileUrl = await fileToBase64(pendingMediaFile);
      } else {
        finalFileUrl = await uploadWithTimeout(pendingMediaFile);
      }
    }

    await addDoc(collection(db, "chats", chatId, "messages"), {
      senderGemixNum: myProfile.gemixNum,
      senderName: myProfile.name,
      type,
      fileUrl: finalFileUrl,
      fileName: pendingMediaFile.name,
      caption,
      createdAt: serverTimestamp()
    });

    closeMediaPreviewModal();
  } catch (err) {
    alert(err.message || "File too large (Max 750KB for direct sync).");
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.innerText = "➤";
  }
};

function uploadWithTimeout(file) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Large file (>750KB) requires Firebase Storage enabled. Try a smaller file/video!"));
    }, 6000);

    const storageRef = ref(storage, `chats_media/${Date.now()}_${file.name}`);
    uploadBytes(storageRef, file)
      .then(() => getDownloadURL(storageRef))
      .then((url) => {
        clearTimeout(timer);
        resolve(url);
      })
      .catch(() => {
        clearTimeout(timer);
        reject(new Error("Keep files/videos under 750KB for instant cloud sync!"));
      });
  });
}

// Two-way WebRTC signaling & synchronized call hangup
function stopAllMediaAndTimers() {
  clearInterval(videoTimerInterval);
  videoTimerInterval = null;
  videoSeconds = 0;

  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  if (remoteStream) {
    remoteStream.getTracks().forEach((track) => track.stop());
    remoteStream = null;
  }
  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.close();
    peerConnection = null;
  }
  if (callStateUnsubscribe) {
    callStateUnsubscribe();
    callStateUnsubscribe = null;
  }
}

function attachCallHangupListener(docId, isVideo) {
  if (callStateUnsubscribe) {
    callStateUnsubscribe();
    callStateUnsubscribe = null;
  }
  const targetDocRef = doc(db, "calls", docId);
  const returnScreen = isVideo ? "video-screen" : "call-screen";

  callStateUnsubscribe = onSnapshot(targetDocRef, (snapshot) => {
    if (!snapshot.exists()) return;
    const data = snapshot.data();
    if (data && (data.status === "ended" || data.status === "declined") && data.endedBy !== myProfile.gemixNum) {
      stopAllMediaAndTimers();
      currentCallDocId = null;
      incomingCallData = null;
      closeSubScreen(returnScreen);
    }
  });
}

window.initiateWebRTCCall = async function (peerName, peerGemixId, isVideo) {
  if (typeof window.showGemixCallScreen === "function") window.showGemixCallScreen(peerName, isVideo, false);
  setTimeout(() => {
    if (typeof window.hideGemixCallScreen === "function") window.hideGemixCallScreen();
    if (typeof window.startGemixProximitySensor === "function") window.startGemixProximitySensor();
  }, 1500);
  currentCallDocId = peerGemixId;
  const screenId = isVideo ? "active-video-screen" : "active-call-screen";
  enterFullScreenView(screenId);

  if (isVideo) {
    document.getElementById("videoRoomTitle").innerText = peerName;
    document.getElementById("videoStatusBadge").innerText = "Connecting WebRTC...";
    startVideoTimer();
  } else {
    document.getElementById("callUserName").innerText = peerName;
    document.getElementById("callStatusText").innerText = "Calling...";
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: isVideo ? { facingMode: useFrontCamera ? "user" : "environment" } : false,
      audio: true
    });

    if (isVideo) {
      setupVideoUI(localStream, null);
      setTimeout(() => {
        if (typeof window.gemixLayoutGroupVideo === "function") window.gemixLayoutGroupVideo("videoInnerContainer");
      }, 200);
    }

    peerConnection = new RTCPeerConnection(rtcServers);
    localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));

    peerConnection.ontrack = (event) => {
      remoteStream = event.streams[0];
      if (isVideo) {
        const remoteVid = document.getElementById("webcamVideo");
        if (remoteVid) {
          remoteVid.srcObject = remoteStream;
          remoteVid.muted = false;
        }
      } else {
        const audioEl = document.getElementById("remoteAudioElement");
        if (audioEl) audioEl.srcObject = remoteStream;
      }
    };

    const callDocRef = doc(db, "calls", peerGemixId);
    const offerCandidates = collection(callDocRef, "offerCandidates");
    const answerCandidates = collection(callDocRef, "answerCandidates");

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        addDoc(offerCandidates, event.candidate.toJSON());
      }
    };

    const offerDescription = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offerDescription);

    await setDoc(callDocRef, {
      offer: { type: offerDescription.type, sdp: offerDescription.sdp },
      callerGemixNum: myProfile.gemixNum,
      callerName: myProfile.name,
      isVideo,
      status: "ringing"
    });

    attachCallHangupListener(peerGemixId, isVideo);

    onSnapshot(callDocRef, async (snapshot) => {
      const data = snapshot.data();
      if (peerConnection && !peerConnection.currentRemoteDescription && data && data.answer) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        if (!isVideo) document.getElementById("callStatusText").innerText = "Connected";
        else document.getElementById("videoStatusBadge").innerText = "Encrypted Call Active";
      }
    });

    onSnapshot(answerCandidates, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === "added" && peerConnection) {
          peerConnection.addIceCandidate(new RTCIceCandidate(change.doc.data()));
        }
      });
    });
  } catch (err) {
    alert("Camera/Mic permission required!");
    stopAllMediaAndTimers();
    closeSubScreen(isVideo ? "video-screen" : "call-screen");
  }
};

window.acceptIncomingCall = async function () {
  if (!incomingCallData) return;
  document.getElementById("incomingCallBanner").classList.remove("show");
  if (typeof window.hideGemixCallScreen === "function") window.hideGemixCallScreen();
  if (typeof window.startGemixProximitySensor === "function") window.startGemixProximitySensor();
  if (typeof window.stopGemixRingtone === "function") window.stopGemixRingtone();
  if (typeof window.stopGemixCallerTune === "function") window.stopGemixCallerTune();

  const isVideo = incomingCallData.isVideo;
  currentCallDocId = myProfile.gemixNum;
  const screenId = isVideo ? "active-video-screen" : "active-call-screen";
  enterFullScreenView(screenId);

  if (isVideo) {
    document.getElementById("videoRoomTitle").innerText = incomingCallData.callerName;
    document.getElementById("videoStatusBadge").innerText = "Encrypted Call Active";
    startVideoTimer();
  } else {
    document.getElementById("callUserName").innerText = incomingCallData.callerName;
    document.getElementById("callStatusText").innerText = "Connected";
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: isVideo ? { facingMode: useFrontCamera ? "user" : "environment" } : false,
      audio: true
    });

    if (isVideo) {
      setupVideoUI(localStream, null);
      setTimeout(() => {
        if (typeof window.gemixLayoutGroupVideo === "function") window.gemixLayoutGroupVideo("videoInnerContainer");
      }, 200);
    }

    peerConnection = new RTCPeerConnection(rtcServers);
    localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));

    peerConnection.ontrack = (event) => {
      remoteStream = event.streams[0];
      if (isVideo) {
        const remoteVid = document.getElementById("webcamVideo");
        if (remoteVid) {
          remoteVid.srcObject = remoteStream;
          remoteVid.muted = false;
        }
      } else {
        const audioEl = document.getElementById("remoteAudioElement");
        if (audioEl) audioEl.srcObject = remoteStream;
      }
    };

    const callDocRef = doc(db, "calls", myProfile.gemixNum);
    const offerCandidates = collection(callDocRef, "offerCandidates");
    const answerCandidates = collection(callDocRef, "answerCandidates");

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        addDoc(answerCandidates, event.candidate.toJSON());
      }
    };

    await peerConnection.setRemoteDescription(new RTCSessionDescription(incomingCallData.offer));
    const answerDescription = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answerDescription);

    await updateDoc(callDocRef, {
      answer: { type: answerDescription.type, sdp: answerDescription.sdp },
      status: "accepted"
    });

    attachCallHangupListener(myProfile.gemixNum, isVideo);

    onSnapshot(offerCandidates, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === "added" && peerConnection) {
          peerConnection.addIceCandidate(new RTCIceCandidate(change.doc.data()));
        }
      });
    });
  } catch (err) {
    stopAllMediaAndTimers();
    closeSubScreen(isVideo ? "video-screen" : "call-screen");
  }
};

window.declineIncomingCall = async function () {
  if (typeof window.stopGemixRingtone === "function") window.stopGemixRingtone();
  if (typeof window.stopGemixCallerTune === "function") window.stopGemixCallerTune();
  document.getElementById("incomingCallBanner").classList.remove("show");
  const myDocRef = doc(db, "calls", myProfile.gemixNum);
  try {
    await updateDoc(myDocRef, { status: "declined", endedBy: myProfile.gemixNum }).catch(() => {});
    setTimeout(async () => {
      await deleteDoc(myDocRef).catch(() => {});
    }, 1500);
  } catch (e) {}
  incomingCallData = null;
};

window.endWebRTCCall = async function (returnScreenId) {
  if (typeof window.stopGemixProximitySensor === "function") window.stopGemixProximitySensor();
  if (typeof window.hideGemixCallScreen === "function") window.hideGemixCallScreen();
  const docIdToEnd = currentCallDocId || (incomingCallData && incomingCallData.callerGemixNum);
  const myDocRef = doc(db, "calls", myProfile.gemixNum);
  const peerDocRef = docIdToEnd ? doc(db, "calls", docIdToEnd) : null;

  stopAllMediaAndTimers();
  currentCallDocId = null;
  incomingCallData = null;

  try {
    await updateDoc(myDocRef, { status: "ended", endedBy: myProfile.gemixNum }).catch(() => {});
    if (peerDocRef) {
      await updateDoc(peerDocRef, { status: "ended", endedBy: myProfile.gemixNum }).catch(() => {});
    }
    setTimeout(async () => {
      await deleteDoc(myDocRef).catch(() => {});
      if (peerDocRef) {
        await deleteDoc(peerDocRef).catch(() => {});
      }
    }, 1500);
  } catch (err) {}

  closeSubScreen(returnScreenId);
};

function setupVideoUI(localVidStream, remoteVidStream) {
  const container = document.getElementById("videoInnerContainer");
  container.innerHTML = `
    <video id="webcamVideo" autoplay playsinline></video>
    <div class="selfie-pip-box" title="Your Camera Feed">
      <video id="selfieVideo" autoplay playsinline muted></video>
    </div>
    <div class="cam-off-placeholder" id="camOffPlaceholder">
      <div class="avatar" style="width:70px; height:70px; font-size:28px;">CAM</div>
      <p style="font-size:13px; font-weight:700;">Camera Paused</p>
    </div>
  `;
  setTimeout(() => {
    const mainVid = document.getElementById("webcamVideo");
    const pipVid = document.getElementById("selfieVideo");
    if (mainVid && pipVid) {
      mainVid.srcObject = remoteVidStream || localVidStream;
      if (!remoteVidStream) mainVid.muted = true;
      pipVid.srcObject = localVidStream;
      pipVid.style.transform = useFrontCamera ? "scaleX(-1)" : "scaleX(1)";
    }
  }, 50);
}

function startVideoTimer() {
  videoSeconds = 0;
  document.getElementById("videoTimer").innerText = "00:00";
  clearInterval(videoTimerInterval);
  videoTimerInterval = setInterval(() => {
    videoSeconds++;
    const mins = Math.floor(videoSeconds / 60).toString().padStart(2, "0");
    const secs = (videoSeconds % 60).toString().padStart(2, "0");
    document.getElementById("videoTimer").innerText = `${mins}:${secs}`;
  }, 1000);
}

window.toggleAudio = function () {
  if (localStream) {
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      const isMuted = !audioTrack.enabled;
      document.getElementById("micToggleBtn")?.classList.toggle("active", isMuted);
      document.getElementById("voiceMuteBtn")?.classList.toggle("active", isMuted);
      if (document.getElementById("micLabel")) {
        document.getElementById("micLabel").innerText = isMuted ? "Unmute" : "Mute";
      }
    }
  }
};

window.toggleVideo = function () {
  if (localStream) {
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      const isOff = !videoTrack.enabled;
      document.getElementById("camToggleBtn")?.classList.toggle("active", isOff);
      const camLabel = document.getElementById("camLabel");
      if (camLabel) camLabel.innerText = isOff ? "Cam On" : "Cam Off";
      const ph = document.getElementById("camOffPlaceholder");
      if (ph) ph.style.display = isOff ? "flex" : "none";
      const pip = document.querySelector(".selfie-pip-box");
      if (pip) pip.style.display = isOff ? "none" : "flex";
    }
  }
};

window.switchCamera = async function () {
  useFrontCamera = !useFrontCamera;
  if (localStream) {
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) videoTrack.stop();
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: useFrontCamera ? "user" : "environment" }
    });
    const newVideoTrack = newStream.getVideoTracks()[0];
    if (peerConnection) {
      const sender = peerConnection.getSenders().find((s) => s.track && s.track.kind === "video");
      if (sender) sender.replaceTrack(newVideoTrack);
    }
    const pipVid = document.getElementById("selfieVideo");
    if (pipVid) {
      pipVid.srcObject = newStream;
      pipVid.style.transform = useFrontCamera ? "scaleX(-1)" : "scaleX(1)";
    }
  }
};

window.toggleBrowserPiP = async function () {
  const remoteVideo = document.getElementById("webcamVideo");
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else if (document.pictureInPictureEnabled && remoteVideo) {
      await remoteVideo.requestPictureInPicture();
    }
  } catch (err) {}
};

// Group conversation controls
window.toggleGroupMode = function () {
  if (contacts.length === 0) {
    alert("Please add VIP contacts first using the + button!");
    return;
  }
  isGroupSelectionMode = !isGroupSelectionMode;
  const groupScreen = document.getElementById("group-screen");
  const actionBar = document.getElementById("groupActionBar");
  const toggleBtn = document.getElementById("groupToggleBtn");

  if (isGroupSelectionMode) {
    groupScreen.classList.add("group-mode");
    actionBar.classList.add("active");
    toggleBtn.innerText = "Cancel Selection";
    toggleBtn.style.background = "#ff4b5c";
    toggleBtn.style.color = "#fff";
  } else {
    groupScreen.classList.remove("group-mode");
    actionBar.classList.remove("active");
    toggleBtn.innerText = "Group Conversation";
    toggleBtn.style.background = "#edf1f8";
    toggleBtn.style.color = "#4285d4";
    document.querySelectorAll(".group-checkbox").forEach((cb) => { cb.checked = false; });
  }
  updateSelectedCount();
};

window.handleGroupCardClick = function (cardElement, name) {
  if (!isGroupSelectionMode) return;
  const checkbox = cardElement.querySelector(".group-checkbox");
  checkbox.checked = !checkbox.checked;
  updateSelectedCount();
};

function updateSelectedCount() {
  const checkedBoxes = document.querySelectorAll(".group-checkbox:checked");
  document.getElementById("selectedCountText").innerText = `${checkedBoxes.length} selected`;
}

window.triggerGroupCall = function (type) {
  const checkedBoxes = document.querySelectorAll(".group-checkbox:checked");
  if (checkedBoxes.length === 0) {
    alert("Please select at least one contact!");
    return;
  }
  const names = Array.from(checkedBoxes).map((cb) => cb.value);
  alert(`Starting Group ${type.toUpperCase()} Room with: ${names.join(", ")}`);
  toggleGroupMode();
};

// Lightbox & utilities
window.openLightbox = function (type, url, fileName) {
  const stage = document.getElementById("lightboxStage");
  document.getElementById("lightboxTitle").innerText = fileName;

  if (type === "image") {
    stage.innerHTML = `<img src="${url}" style="max-height:65dvh;" alt="${fileName}">`;
  } else if (type === "pdf") {
    stage.innerHTML = `<iframe src="${url}" style="width:100%; height:65dvh; border:none; border-radius:12px;"></iframe>`;
  } else {
    stage.innerHTML = `
      <div class="doc-preview-card">
        <div class="doc-preview-icon">DOC</div>
        <div style="font-size:15px; font-weight:700; color:#222835;">${fileName}</div>
        <a href="${url}" download="${fileName}" class="save-contact-btn" style="text-decoration:none; padding:10px 20px; font-size:13px; margin-top:8px;">Download File</a>
      </div>
    `;
  }
  document.getElementById("lightboxModal").classList.add("open");
};

window.closeLightbox = function () {
  document.getElementById("lightboxModal").classList.remove("open");
};

function escapeHtml(text) {
  if (!text) return "";
  const map = { "&": "&", "<": "<", ">": ">", '"': """, "'": "'" };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

window.switchScreen = function (screenId, clickedElement) {
  if (!document.getElementById(screenId)) return;
  document.body.classList.remove("fullscreen-mode");
  document.getElementById("topBar").style.display = "flex";
  document.getElementById("bottomNav").style.display = "flex";

  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById(screenId).classList.add("active");

  document.querySelectorAll(".btn-wrap, .neumo-btn, .nav-btn").forEach((el) => el.classList.remove("active"));

  if (clickedElement) {
    if (clickedElement.classList.contains("btn-wrap")) {
      clickedElement.classList.add("active");
      const innerBtn = clickedElement.querySelector(".neumo-btn");
      if (innerBtn) innerBtn.classList.add("active");
    } else {
      clickedElement.classList.add("active");
    }
  }
};

function enterFullScreenView(screenId) {
  document.body.classList.add("fullscreen-mode");
  document.getElementById("topBar").style.display = "none";
  document.getElementById("bottomNav").style.display = "none";

  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById(screenId).classList.add("active");
}

window.closeSubScreen = function (returnScreenId) {
  if (typeof window.cancelVoiceNote === "function") window.cancelVoiceNote();
  if (typeof window.closeMediaPreviewModal === "function") window.closeMediaPreviewModal();
  if (typeof window.closeLightbox === "function") window.closeLightbox();
  if (typeof window.closeMsgActionModal === "function") window.closeMsgActionModal();

  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(() => {});
  }

  stopAllMediaAndTimers();

  const tabMap = {
    "chat-screen": "tab-chat",
    "call-screen": "tab-call",
    "video-screen": "tab-video",
    "group-screen": "tab-group"
  };
  if (typeof window.switchScreen === "function") {
    window.switchScreen(returnScreenId, document.getElementById(tabMap[returnScreenId]));
  }
};


// ============ NEOMORPHIC RECEIVER SCREEN + AVATAR V-BUG FIX ============
(function () {
  const st = document.createElement("style");
  st.id = "gemixNeoReceiverStyle";
  st.textContent = `
  .gemix-call-screen{position:fixed;inset:0;z-index:999;background:#edf1f8 !important;display:none;flex-direction:column;align-items:center;justify-content:space-between;padding:52px 24px 34px;color:#222835;font-family:sans-serif}
  .gemix-call-screen.show{display:flex}
  .gemix-neo-name{font-size:32px;font-weight:800;color:#222835;text-align:center;line-height:1.1}
  .gemix-neo-status{font-size:16px;color:#4285d4;margin-top:10px;text-align:center;font-weight:500}
  .gemix-neo-avatar{width:180px;height:180px;border-radius:50%;background:#eef2f7;color:#4285d4;display:grid;place-items:center;font-size:84px;font-weight:300;border:2.5px solid #d4af37;box-shadow:14px 14px 28px rgba(163,177,198,.55),-14px -14px 28px rgba(255,255,255,.95),inset 0 0 0 6px #eef2f7}
  .gemix-neo-avatar.ringing{animation:gemixNeoPulse 1.6s ease-in-out infinite}
  @keyframes gemixNeoPulse{0%,100%{transform:scale(1);box-shadow:14px 14px 28px rgba(163,177,198,.55),-14px -14px 28px rgba(255,255,255,.95)}50%{transform:scale(1.04);box-shadow:18px 18px 34px rgba(163,177,198,.65),-18px -18px 34px rgba(255,255,255,1)}}
  .gemix-neo-row{display:flex;gap:34px;justify-content:center;width:100%;align-items:flex-start}
  .gemix-neo-action{display:flex;flex-direction:column;align-items:center;gap:10px}
  .gemix-neo-btn{width:72px;height:72px;border-radius:50%;border:2px solid #d4af37;background:#eef2f7;color:#222835;font-size:26px;cursor:pointer;display:grid;place-items:center;box-shadow:8px 8px 16px rgba(163,177,198,.55),-8px -8px 16px rgba(255,255,255,.95)}
  .gemix-neo-btn:active{box-shadow:inset 6px 6px 12px rgba(163,177,198,.5),inset -6px -6px 12px rgba(255,255,255,.9);transform:scale(.96)}
  .gemix-neo-label{font-size:14px;color:#5b6472}
  .gemix-neo-label.end{color:#ff4b5c}
  .gemix-neo-btn.accept{background:#2ecc71;border-color:#2ecc71;color:#fff;box-shadow:8px 8px 16px rgba(46,204,113,.4),-8px -8px 16px rgba(255,255,255,.95)}
  .gemix-neo-btn.decline{background:#ff4b5c;border-color:#ff4b5c;color:#fff;box-shadow:8px 8px 16px rgba(255,80,92,.4),-8px -8px 16px rgba(255,255,255,.95)}
  .gemix-neo-btn.muted{background:#d4af37;color:#fff}
  `;
  document.head.appendChild(st);
})();

window.gemixNeoToggleMute = function (btn) {
  const on = btn.classList.toggle("muted");
  btn.innerText = on ? "🔇" : "🎤";
  if (typeof window.toggleAudio === "function") window.toggleAudio();
};

window.gemixNeoToggleSpeaker = function (btn) {
  const on = btn.classList.toggle("muted");
  btn.innerText = on ? "🔈" : "🔊";
  const audioEl = document.getElementById("remoteAudioElement");
  if (audioEl) audioEl.volume = on ? 1.0 : 0.7;
};

window.gemixResolveContactForCall = function (nameOrId) {
  try {
    if (!contacts || !contacts.length) return null;
    if (!nameOrId) return null;
    let c = contacts.find((x) => String(x.gemixId) === String(nameOrId));
    if (c) return c;
    c = contacts.find((x) => (x.name || "").toLowerCase() === String(nameOrId).toLowerCase());
    if (c) return c;
    if (incomingCallData && incomingCallData.callerGemixNum) {
      c = contacts.find((x) => String(x.gemixId) === String(incomingCallData.callerGemixNum));
      if (c) return c;
    }
    return null;
  } catch (e) {
    return null;
  }
};

window.showGemixCallScreen = function (callerName, isVideo, isIncoming) {
  let el = document.getElementById("gemixCallScreen");
  if (!el) {
    el = document.createElement("div");
    el.id = "gemixCallScreen";
    el.className = "gemix-call-screen";
    document.body.appendChild(el);
  }
  let contact = window.gemixResolveContactForCall(callerName);
  if (isIncoming && incomingCallData && incomingCallData.callerGemixNum) {
    const byId = window.gemixResolveContactForCall(incomingCallData.callerGemixNum);
    if (byId) contact = byId;
  }
  let displayName = callerName || "";
  if (isIncoming && contact && contact.name) displayName = contact.name;
  if (!displayName || displayName === "VIP Contact") displayName = (contact && contact.name) || "VIP Contact";

  const initial = (contact && contact.initial) ? String(contact.initial).toUpperCase() : displayName.charAt(0).toUpperCase();
  const avatarInner = (contact && contact.avatarUrl)
    ? `<img src="${contact.avatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%" onerror="this.remove()">`
    : initial;
  const status = isIncoming
    ? (isVideo ? "Incoming Video Call..." : "Incoming Call...")
    : (isVideo ? "Calling Video..." : "Calling...");
  const footer = isIncoming
    ? `<div class="gemix-neo-row"><div class="gemix-neo-action"><button class="gemix-neo-btn decline" onclick="gemixDeclineFromCallScreen()">📵</button><span class="gemix-neo-label end">Decline</span></div><div class="gemix-neo-action"><button class="gemix-neo-btn accept" onclick="gemixAcceptFromCallScreen()">📞</button><span class="gemix-neo-label">Accept</span></div></div>`
    : `<div class="gemix-neo-row"><div class="gemix-neo-action"><button class="gemix-neo-btn" onclick="gemixNeoToggleMute(this)">🎤</button><span class="gemix-neo-label">Mute</span></div><div class="gemix-neo-action"><button class="gemix-neo-btn decline" onclick="gemixDeclineFromCallScreen()">📵</button><span class="gemix-neo-label end">End</span></div><div class="gemix-neo-action"><button class="gemix-neo-btn" onclick="gemixNeoToggleSpeaker(this)">🔊</button><span class="gemix-neo-label">Speaker</span></div></div>`;
  el.innerHTML = `<div style="text-align:center"><div class="gemix-neo-name">${displayName}</div><div class="gemix-neo-status">${status}</div></div><div class="gemix-neo-avatar ringing">${avatarInner}</div>${footer}`;
  el.classList.add("show");
};
// ============ END NEOMORPHIC RECEIVER ============