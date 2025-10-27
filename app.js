const trackers = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.sloppyta.co:443/announce',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.opentrackr.org:443/announce'
];

const TOPIC = 'flick-webrtc-lan-v1';
const STORAGE_KEY = 'flick-display-name';
const PRESENCE_INTERVAL = 8000;
const CHUNK_SIZE = 64 * 1024; // 64 KiB

const P2PTConstructor = window.P2PT || globalThis.P2PT;

if (!P2PTConstructor) {
  throw new Error('P2PT library failed to load.');
}

const p2pt = new P2PTConstructor(trackers, TOPIC, {trickle: true});

const state = {
  me: {
    id: crypto.randomUUID(),
    name: localStorage.getItem(STORAGE_KEY) || buildRandomName()
  },
  peers: new Map(), // id -> {id, name, lastSeen, status, element}
  conversations: new Map(), // id -> [message]
  activePeerId: null,
  notifications: [],
  incomingTransfers: new Map(), // transferId -> {...}
};

const displayNameInput = document.getElementById('display-name');
const selfStatus = document.getElementById('self-status');
const peerList = document.getElementById('peer-list');
const peerTemplate = document.getElementById('peer-template');
const chatMessages = document.getElementById('chat-messages');
const chatPlaceholder = document.getElementById('chat-placeholder');
const composer = document.getElementById('composer');
const messageInput = document.getElementById('message-input');
const sendButton = document.getElementById('send-button');
const fileInput = document.getElementById('file-input');
const notificationTray = document.getElementById('notification-tray');
const notificationTemplate = document.getElementById('notification-template');
const activePeerName = document.getElementById('active-peer-name');
const activePeerStatus = document.getElementById('active-peer-status');
const activePeerAvatar = document.getElementById('active-peer-avatar');
const activePeerInfo = document.getElementById('active-peer-info');
const meAvatar = document.getElementById('me-avatar');

let presenceTimer;

initialize();

function initialize() {
  displayNameInput.value = state.me.name;
  updateAvatar(meAvatar, state.me.id, state.me.name);
  updateSelfStatus('connecting');

  displayNameInput.addEventListener('input', handleNameChange);
  sendButton.addEventListener('click', handleSendMessage);
  messageInput.addEventListener('keydown', evt => {
    if (evt.key === 'Enter' && !evt.shiftKey) {
      evt.preventDefault();
      handleSendMessage();
    }
  });
  fileInput.addEventListener('change', handleFileSelected);

  setupP2PT();
}

function setupP2PT() {
  p2pt.on('trackerconnect', (_, tracker) => {
    updateSelfStatus('online');
    console.info('Connected to tracker', tracker.announce);
  });

  p2pt.on('trackerwarning', (_, err) => {
    console.warn('Tracker warning', err);
    updateSelfStatus('degraded');
  });

  p2pt.on('trackerdisconnect', () => {
    updateSelfStatus('connecting');
  });

  p2pt.on('peerconnect', peer => {
    const peerId = peer.id;
    console.info('Peer connected', peerId);
    const info = ensurePeerEntry(peerId);
    info.connection = peer;
    broadcastPresenceTo(peerId);
  });

  p2pt.on('peerclose', peer => {
    const peerId = peer.id;
    console.info('Peer disconnected', peerId);
    const info = state.peers.get(peerId);
    if (info) {
      info.status = 'away';
      info.lastSeen = Date.now();
      info.connection = null;
      if (info.element) {
        info.element.classList.add('unavailable');
        info.element.querySelector('.peer-status').textContent = 'Last seen moments ago';
      }
    }
  });

  p2pt.on('data', (peer, raw) => {
    try {
      const data = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(new TextDecoder().decode(raw));
      handleIncomingData(peer.id, data);
    } catch (error) {
      console.error('Failed to parse message', error, raw);
    }
  });

  p2pt.start();

  presenceTimer = setInterval(() => {
    broadcastPresence();
  }, PRESENCE_INTERVAL);

  broadcastPresence();
}

function handleNameChange(evt) {
  const name = evt.target.value.trim() || buildRandomName();
  state.me.name = name;
  evt.target.value = name;
  localStorage.setItem(STORAGE_KEY, name);
  updateAvatar(meAvatar, state.me.id, state.me.name);
  broadcastPresence();
  const activePeer = state.peers.get(state.activePeerId);
  if (activePeer) {
    renderActivePeer(activePeer);
  }
}

function updateSelfStatus(status) {
  if (status === 'online') {
    selfStatus.textContent = 'online';
    selfStatus.style.background = 'rgba(74, 222, 128, 0.18)';
    selfStatus.style.color = '#4ade80';
  } else if (status === 'degraded') {
    selfStatus.textContent = 'unstable';
    selfStatus.style.background = 'rgba(250, 204, 21, 0.2)';
    selfStatus.style.color = '#facc15';
  } else {
    selfStatus.textContent = 'connecting…';
    selfStatus.style.background = 'rgba(148, 163, 184, 0.2)';
    selfStatus.style.color = '#cbd5f5';
  }
}

function ensurePeerEntry(peerId) {
  if (state.peers.has(peerId)) {
    const existing = state.peers.get(peerId);
    existing.status = 'online';
    existing.lastSeen = Date.now();
    if (existing.element) {
      existing.element.classList.remove('unavailable');
      existing.element.querySelector('.peer-status').textContent = 'Online now';
    }
    return existing;
  }

  const instance = peerTemplate.content.firstElementChild.cloneNode(true);
  const avatar = instance.querySelector('.avatar');
  const nameNode = instance.querySelector('.peer-name');
  const statusNode = instance.querySelector('.peer-status');
  const unreadNode = instance.querySelector('.peer-unread');
  instance.dataset.peerId = peerId;
  instance.addEventListener('click', () => openConversation(peerId));

  updateAvatar(avatar, peerId);
  nameNode.textContent = 'Unknown peer';
  statusNode.textContent = 'Connecting…';

  if (peerList.classList.contains('empty-state')) {
    peerList.classList.remove('empty-state');
    peerList.innerHTML = '';
  }

  peerList.appendChild(instance);

  const info = {
    id: peerId,
    name: 'Unknown peer',
    lastSeen: Date.now(),
    status: 'online',
    element: instance,
    unreadNode,
    unread: 0,
    connection: null,
  };
  state.peers.set(peerId, info);
  return info;
}

function openConversation(peerId) {
  const peerInfo = state.peers.get(peerId);
  if (!peerInfo) return;
  state.activePeerId = peerId;
  renderActivePeer(peerInfo);
  composer.hidden = false;
  chatPlaceholder.hidden = true;
  peerList.querySelectorAll('.peer').forEach(node => node.classList.remove('active'));
  if (peerInfo.element) peerInfo.element.classList.add('active');
  peerInfo.unread = 0;
  if (peerInfo.unreadNode) {
    peerInfo.unreadNode.hidden = true;
  }
  renderMessages(peerId);
  dismissNotificationsForPeer(peerId);
}

function renderActivePeer(peerInfo) {
  activePeerName.textContent = peerInfo.name || 'Unknown peer';
  activePeerStatus.textContent = peerInfo.status === 'online' ? 'Connected' : 'Last seen moments ago';
  updateAvatar(activePeerAvatar, peerInfo.id, peerInfo.name);
}

function renderMessages(peerId) {
  const history = state.conversations.get(peerId) || [];
  chatMessages.innerHTML = '';
  history.forEach(entry => {
    chatMessages.appendChild(buildMessageBubble(entry));
  });
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function buildMessageBubble(entry) {
  const template = document.getElementById('message-template');
  const node = template.content.firstElementChild.cloneNode(true);
  node.dataset.messageId = entry.id;
  if (entry.sender === 'me') node.classList.add('mine');
  const bubble = node.querySelector('.bubble');
  const meta = node.querySelector('.meta');

  if (entry.type === 'text') {
    bubble.textContent = entry.text;
  } else if (entry.type === 'file') {
    bubble.innerHTML = '';
    const link = document.createElement('a');
    link.className = 'file-card';
    link.href = entry.url || '#';
    link.download = entry.fileName;
    link.target = '_blank';
    if (!entry.url) {
      link.dataset.pending = 'true';
    }
    const thumb = document.createElement('div');
    thumb.className = 'file-thumb';
    thumb.textContent = entry.fileType?.startsWith('image/') ? '🖼️' : '📄';
    const metaBlock = document.createElement('div');
    metaBlock.className = 'file-meta';
    const title = document.createElement('div');
    title.textContent = entry.fileName;
    title.style.fontWeight = '600';
    const subtitle = document.createElement('div');
    subtitle.style.fontSize = '12px';
    subtitle.style.opacity = '0.7';
    subtitle.textContent = entry.url ? formatFileSize(entry.fileSize) : `Receiving… ${Math.round((entry.progress || 0) * 100)}%`;
    metaBlock.append(title, subtitle);
    link.append(thumb, metaBlock);
    bubble.appendChild(link);
  }

  meta.textContent = `${entry.sender === 'me' ? 'You' : entry.senderName || 'Peer'} • ${formatTimestamp(entry.timestamp)}`;
  return node;
}

function appendMessage(peerId, message) {
  if (!state.conversations.has(peerId)) {
    state.conversations.set(peerId, []);
  }
  const timeline = state.conversations.get(peerId);
  const index = timeline.findIndex(item => item.id === message.id);
  if (index >= 0) {
    timeline[index] = {...timeline[index], ...message};
  } else {
    timeline.push(message);
  }

  if (state.activePeerId === peerId) {
    renderMessages(peerId);
  } else {
    const peerInfo = state.peers.get(peerId);
    if (peerInfo) {
      peerInfo.unread = (peerInfo.unread || 0) + 1;
      if (peerInfo.unreadNode) {
        peerInfo.unreadNode.hidden = false;
        peerInfo.unreadNode.textContent = peerInfo.unread;
      }
    }
  }
}

function handleSendMessage() {
  const text = messageInput.value.trim();
  if (!text || !state.activePeerId) return;
  const payload = {
    type: 'message',
    text,
    timestamp: Date.now(),
    senderId: state.me.id,
    senderName: state.me.name,
  };
  sendToPeer(state.activePeerId, payload);
  const entry = {
    id: crypto.randomUUID(),
    sender: 'me',
    senderName: state.me.name,
    type: 'text',
    text,
    timestamp: payload.timestamp,
  };
  appendMessage(state.activePeerId, entry);
  messageInput.value = '';
}

function handleFileSelected(evt) {
  const file = evt.target.files?.[0];
  if (!file || !state.activePeerId) return;
  evt.target.value = '';
  sendFileToPeer(state.activePeerId, file);
}

async function sendFileToPeer(peerId, file) {
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE) || 1;
  const transferId = `${state.me.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const timestamp = Date.now();
  const entry = {
    id: transferId,
    sender: 'me',
    senderName: state.me.name,
    type: 'file',
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type,
    url: URL.createObjectURL(file),
    timestamp,
    progress: 1,
  };
  appendMessage(peerId, entry);

  const meta = {
    type: 'file-meta',
    transferId,
    timestamp,
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type,
    totalChunks,
    senderId: state.me.id,
    senderName: state.me.name,
  };
  sendToPeer(peerId, meta);

  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  for (let index = 0; index < totalChunks; index++) {
    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, bytes.length);
    const chunk = bytes.slice(start, end);
    const payload = {
      type: 'file-chunk',
      transferId,
      index,
      totalChunks,
      data: Array.from(chunk),
    };
    sendToPeer(peerId, payload);
  }
  sendToPeer(peerId, { type: 'file-complete', transferId });
}

function broadcastPresence() {
  const payload = {
    type: 'presence',
    senderId: state.me.id,
    senderName: state.me.name,
    timestamp: Date.now(),
  };
  broadcast(payload);
}

function broadcastPresenceTo(peerId) {
  const payload = {
    type: 'presence',
    senderId: state.me.id,
    senderName: state.me.name,
    timestamp: Date.now(),
  };
  sendToPeer(peerId, payload);
}

function sendToPeer(peerId, payload) {
  const data = JSON.stringify(payload);
  const info = state.peers.get(peerId);
  if (info?.connection && info.connection.connected) {
    try {
      info.connection.send(data);
      return;
    } catch (error) {
      console.warn('Direct send failed, falling back to broadcast channel', error);
    }
  }
  try {
    p2pt.send(peerId, data);
  } catch (error) {
    console.error('Failed sending payload to peer', peerId, error);
  }
}

function broadcast(payload) {
  try {
    p2pt.broadcast(JSON.stringify(payload));
  } catch (error) {
    console.error('Failed broadcasting payload', error);
  }
}

function handleIncomingData(peerId, message) {
  const peerInfo = ensurePeerEntry(peerId);
  peerInfo.status = 'online';
  peerInfo.lastSeen = Date.now();
  if (peerInfo.element) {
    peerInfo.element.classList.remove('unavailable');
    const statusEl = peerInfo.element.querySelector('.peer-status');
    if (statusEl) {
      statusEl.textContent = 'Online now';
    }
  }

  switch (message.type) {
    case 'presence':
      updatePeerIdentity(peerId, message.senderName);
      break;
    case 'message':
      updatePeerIdentity(peerId, message.senderName);
      handleIncomingMessage(peerId, message);
      break;
    case 'file-meta':
      updatePeerIdentity(peerId, message.senderName);
      handleIncomingFileMeta(peerId, message);
      break;
    case 'file-chunk':
      handleIncomingFileChunk(peerId, message);
      break;
    case 'file-complete':
      finalizeIncomingFile(peerId, message.transferId);
      break;
    default:
      console.debug('Unknown message type', message);
  }
}

function updatePeerIdentity(peerId, name) {
  const info = ensurePeerEntry(peerId);
  if (name && info.name !== name) {
    info.name = name;
    if (info.element) {
      info.element.querySelector('.peer-name').textContent = name;
    }
    updateAvatar(info.element?.querySelector('.avatar'), peerId, name);
    if (state.activePeerId === peerId) {
      renderActivePeer(info);
    }
  }
}

function handleIncomingMessage(peerId, payload) {
  const entry = {
    id: crypto.randomUUID(),
    sender: 'peer',
    senderName: payload.senderName || 'Peer',
    type: 'text',
    text: payload.text,
    timestamp: payload.timestamp || Date.now(),
  };
  appendMessage(peerId, entry);
  if (state.activePeerId !== peerId) {
    pushNotification({
      peerId,
      kind: 'message',
      title: payload.senderName || 'Peer',
      preview: payload.text,
    });
  }
}

function handleIncomingFileMeta(peerId, payload) {
  const { transferId, fileName, fileSize, fileType, senderName, timestamp, totalChunks } = payload;
  const entry = {
    id: transferId,
    sender: 'peer',
    senderName: senderName || 'Peer',
    type: 'file',
    fileName,
    fileSize,
    fileType,
    timestamp: timestamp || Date.now(),
    progress: 0,
  };
  appendMessage(peerId, entry);
  state.incomingTransfers.set(transferId, {
    peerId,
    fileName,
    fileSize,
    fileType,
    totalChunks,
    chunks: new Array(totalChunks),
    received: 0,
    messageId: transferId,
    senderName,
  });
}

function handleIncomingFileChunk(peerId, payload) {
  const { transferId, index, totalChunks, data } = payload;
  const transfer = state.incomingTransfers.get(transferId);
  if (!transfer) {
    console.warn('No transfer state for chunk', transferId);
    return;
  }
  transfer.chunks[index] = new Uint8Array(data);
  transfer.received += 1;
  transfer.totalChunks = totalChunks;
  const progress = transfer.received / transfer.totalChunks;
  updateFileProgress(transfer.peerId, transfer.messageId, progress);
}

function finalizeIncomingFile(peerId, transferId) {
  const transfer = state.incomingTransfers.get(transferId);
  if (!transfer) return;
  const blob = new Blob(transfer.chunks.filter(Boolean), { type: transfer.fileType || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  updateFileMessage(peerId, transfer.messageId, url, 1);
  state.incomingTransfers.delete(transferId);
  if (state.activePeerId !== peerId) {
    pushNotification({
      peerId,
      kind: transfer.fileType?.startsWith('image/') ? 'image' : 'file',
      title: transfer.senderName || 'Peer',
      preview: transfer.fileName,
      imageUrl: transfer.fileType?.startsWith('image/') ? url : null,
    });
  }
}

function updateFileProgress(peerId, messageId, progress) {
  const history = state.conversations.get(peerId) || [];
  const idx = history.findIndex(item => item.id === messageId);
  if (idx === -1) return;
  history[idx] = {
    ...history[idx],
    progress,
  };
  if (state.activePeerId === peerId) {
    renderMessages(peerId);
  }
}

function updateFileMessage(peerId, messageId, url, progress = 1) {
  const history = state.conversations.get(peerId) || [];
  const idx = history.findIndex(item => item.id === messageId);
  if (idx === -1) return;
  history[idx] = {
    ...history[idx],
    url,
    progress,
  };
  if (state.activePeerId === peerId) {
    renderMessages(peerId);
  }
}

function dismissNotificationsForPeer(peerId) {
  const nodes = [...notificationTray.querySelectorAll('.notification-pill')];
  nodes.forEach(node => {
    if (node.dataset.peerId === peerId) {
      node.remove();
    }
  });
}

function pushNotification({ peerId, kind, title, preview, imageUrl }) {
  const template = notificationTemplate.content.firstElementChild.cloneNode(true);
  template.dataset.peerId = peerId;
  template.querySelector('.title').textContent = title || 'Peer';
  const previewNode = template.querySelector('.preview');
  if (kind === 'message') {
    previewNode.textContent = truncate(preview || '', 72);
  } else if (kind === 'image') {
    previewNode.textContent = `New image sent by: ${title || 'peer'}`;
    const thumb = template.querySelector('.thumb');
    thumb.hidden = false;
    const img = document.createElement('img');
    img.src = imageUrl;
    img.alt = 'Image preview';
    thumb.appendChild(img);
  } else {
    previewNode.textContent = `New file sent: ${preview}`;
  }

  template.addEventListener('click', () => {
    openConversation(peerId);
    template.remove();
  });
  template.querySelector('.close').addEventListener('click', evt => {
    evt.stopPropagation();
    template.remove();
  });

  notificationTray.appendChild(template);
  if (notificationTray.children.length > 4) {
    notificationTray.firstElementChild.remove();
  }
}

function updateAvatar(node, seed, name = '') {
  if (!node) return;
  const initials = computeInitials(name);
  node.textContent = initials;
  const palette = buildGradient(seed || name || 'peer');
  node.style.background = `linear-gradient(135deg, ${palette[0]}, ${palette[1]})`;
}

function computeInitials(name) {
  if (!name) return '??';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function buildGradient(seed) {
  const hash = Array.from(seed).reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const hue = hash % 360;
  return [`hsl(${hue}, 82%, 58%)`, `hsl(${(hue + 40) % 360}, 84%, 52%)`];
}

function formatTimestamp(ts) {
  const date = new Date(ts);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 'KB';
  for (let i = 0; i < units.length; i++) {
    if (value < 1024 || i === units.length - 1) {
      unit = units[i];
      break;
    }
    value /= 1024;
  }
  return `${value.toFixed(1)} ${unit}`;
}

function truncate(value, max = 48) {
  if (!value) return '';
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function buildRandomName() {
  const adjectives = ['Swift', 'Bright', 'Silent', 'Brave', 'Calm', 'Nimble', 'Clever'];
  const nouns = ['Comet', 'Photon', 'Pixel', 'Beacon', 'Signal', 'Aurora', 'Nova'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adj} ${noun}`;
}

window.addEventListener('beforeunload', () => {
  clearInterval(presenceTimer);
});
