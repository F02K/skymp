// ── skymp5-chat — Server-side chat module ─────────────────────────────────────
//
// Drop-in replacement for skymp5-gamemode/src/systems/communication/chat.ts.
// Deploy to that path (via `npm run deploy:server` in skymp5-chat/) to use.
//
// Channels
//   IC (default)   proximity speech within SAY_RANGE
//   /me            roleplay action, proximity
//   /ooc           global out-of-character
//   /w <name>      private whisper (must be within WHISPER_RANGE)
//   /f             faction members only
//
// Server → Client flow
//   deliver() → mp.set(actorId, 'ff_chatMsg', '#{rrggbb}text…') → updateOwner
//   → executeJavaScript → parses #{color} codes → widgets.set → React re-render
//
// Client → Server flow
//   Chat input → window.skyrimPlatform.sendMessage('chatSend', text) → BrowserMessage
//   → makeEventSource browserMessage listener → mp._onChatSend → handleChatInput()
//
// Public API (same as original chat.ts — no gamemode changes needed)
//   init(mp)
//   handleChatInput(mp, store, userId, text): boolean  — true = consumed
//   sendSystem(mp, store, userId, text)
//   broadcastSystem(mp, store, text)
//   sendToPlayer(mp, store, userId, text, color?)      — legacy plain-text
//   broadcast(mp, store, text, color?)                 — legacy plain-text
//   registerChannel(channel)                           — add custom channel
//
// Extensibility
//   Use registerChannel({ prefix, handle }) to add new channels without
//   modifying this file. Channels are matched by prefix before IC fallback.

import { signScript } from '../../core/signHelper'
import { safeCall, safeSet } from '../../core/mpUtil'
import type { Mp, Store } from '../../types'

// ── Config ────────────────────────────────────────────────────────────────────

const CHAT_MSG_PROP  = 'ff_chatMsg'
const SAY_RANGE      = 3500    // Skyrim units ≈ 50 m
const WHISPER_RANGE  = 400     // units ≈ 6 m
export const MAX_MSG_LEN = 300
const MAX_HISTORY    = 30
const RATE_LIMIT_MS  = 1000

// ── Client-side bridge ────────────────────────────────────────────────────────
//
// updateOwner runs in the Skyrim Platform Chakra context (ES5-safe) whenever
// the server sets a new value on 'ff_chatMsg'.
//
// Message wire format: "#{rrggbb}segment1#{rrggbb}segment2…"
// The browser-side code parses #{color} codes into Span segments and pushes a
// new ChatMsg into window.chatMessages, then refreshes the widgets array so
// the React chat component re-renders.

// updateOwner fires on every game tick (not just on property change), so we
// use ctx.state to guard against re-delivering the same value each frame.
// When the property is reset to '' (the clear-before-send pattern in deliver()),
// we wipe the guard so the same payload can be shown again if re-sent.
// The send function injected into the chat widget.
// window.mp.send is wired by App.js componentDidMount → skyrimPlatform.sendMessage,
// which the SkyMP client forwards to the server as a customPacket {type, data}.
// MUST use only single quotes — this string is embedded inside Chakra double-quoted string pieces.
const CHAT_SEND_JS =
  "function(t){if(window.mp&&typeof window.mp.send==='function')window.mp.send('cef::chat:send',t);}"

// Parses '#{rrggbb}text#{rrggbb}text…' into a ChatMsg compatible with the
// skymp5-front Chat component.  Split on '#{' — first piece may be unstyled
// text, subsequent pieces start with 'rrggbb}' then the text body.
// MUST use only single quotes — same embedding constraint as CHAT_SEND_JS.
const PARSE_MSG_JS =
  "var parts=raw.split('#{');" +
  "var segs=[];var col='#fafafa';" +
  "for(var i=0;i<parts.length;i++){" +
  "var p=parts[i];" +
  "if(i===0){if(p)segs.push({text:p,color:col,opacity:1,type:['default']});continue;}" +
  "var ci=p.indexOf('}');" +
  "if(ci===6){col='#'+p.slice(0,6);var txt=p.slice(7);if(txt)segs.push({text:txt,color:col,opacity:1,type:['default']});}" +
  "else{segs.push({text:'#{'+p,color:col,opacity:1,type:['default']});}" +
  "}"

const UPDATE_OWNER_JS = `
(function(){
  ctx.sp.browser.executeJavaScript(
    "(function(){"+
    "  try{"+
    "    if(!window.chatMessages)window.chatMessages=[];"+
    "    if(!window.skyrimPlatform||!window.skyrimPlatform.widgets)return;"+
    "    var ws=window.skyrimPlatform.widgets.get();"+
    "    if(ws.some(function(w){return w.type==='chat';}))return;"+
    "    var sf=${CHAT_SEND_JS};"+
    "    window.skyrimPlatform.widgets.set(ws.concat([{type:'chat',messages:window.chatMessages.slice(),send:sf}]));"+
    "  }catch(e){}"+
    "})();"
  );
  var rawMsg=String(ctx.value||'');
  if(!rawMsg){ctx.state._chatLastMsg='';return;}
  if(ctx.state._chatLastMsg===rawMsg)return;
  ctx.state._chatLastMsg=rawMsg;
  var safeMsg=JSON.stringify(rawMsg);
  ctx.sp.browser.executeJavaScript(
    '(function(){'+
    '  try{'+
    '    var raw='+safeMsg+';'+
    '    ${PARSE_MSG_JS}'+
    '    if(!segs.length)return;'+
    '    if(!window.chatMessages)window.chatMessages=[];'+
    '    window.chatMessages.push({text:segs,category:\'plain\',opacity:1});'+
    '    if(window.chatMessages.length>50)window.chatMessages.shift();'+
    '    if(!window.skyrimPlatform||!window.skyrimPlatform.widgets)return;'+
    '    var ws=window.skyrimPlatform.widgets.get();'+
    '    var found=false;'+
    '    var next=ws.map(function(w){'+
    '      if(w.type!==\'chat\')return w;'+
    '      found=true;'+
    '      return Object.assign({},w,{messages:window.chatMessages.slice()});'+
    '    });'+
    '    if(!found){'+
    '      var sf=${CHAT_SEND_JS};'+
    '      next=ws.concat([{type:\'chat\',messages:window.chatMessages.slice(),send:sf}]);'+
    '    }'+
    '    window.skyrimPlatform.widgets.set(next);'+
    '    if(typeof window.scrollToLastMessage===\'function\')window.scrollToLastMessage();'+
    '  }catch(e){}'+
    '})();'
  );
})();
`.trim()

// ── Color palette ─────────────────────────────────────────────────────────────

const C = {
  nameIc:      '#e8c87a',
  nameOoc:     '#8888bb',
  nameFaction: '#66bb66',
  nameWhisper: '#bb88cc',
  nameSystem:  '#ff9933',
  tagIc:       '#666666',
  tagOoc:      '#444466',
  tagFaction:  '#335533',
  tagWhisper:  '#553366',
  msgIc:       '#ffffff',
  msgOoc:      '#ccccdd',
  msgMe:       '#ccccbb',
  msgWhisper:  '#cc99ff',
  msgFaction:  '#aaddaa',
  system:      '#ffcc44',
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Span    { text: string; color: string; opacity: number; type: string[] }
interface ChatMsg { category: string; text: Span[]; opacity: number }

function sp(text: string, color: string, types: string[] = ['text']): Span {
  return { text, color, opacity: 1, type: types }
}

function mkMsg(category: 'plain' | 'rp', ...spans: Span[]): ChatMsg {
  return { category, text: spans, opacity: 1 }
}

function spansToColorString(spans: Span[]): string {
  return spans.map(s => `#{${normalizeColor(s.color)}}${escapeColorMarkers(s.text)}`).join('')
}

function normalizeColor(color: string): string {
  const raw = color.startsWith('#') ? color.slice(1) : color
  return /^[0-9a-fA-F]{6}$/.test(raw) ? raw : 'ffffff'
}

function matchesChannelPrefix(text: string, prefix: string): boolean {
  return text === prefix || text.startsWith(prefix + ' ')
}

function escapeColorMarkers(text: string): string {
  return text.replace(/#\{/g, '# {')
}

// ── Channel registry ──────────────────────────────────────────────────────────

interface ChannelContext {
  mp: Mp
  store: Store
  userId: number
  text: string
  player: NonNullable<ReturnType<Store['get']>>
}

interface Channel {
  /** Command prefix including slash, e.g. '/ooc'. Empty string = default IC. */
  prefix: string
  handle(ctx: ChannelContext): void
}

const extraChannels: Channel[] = []

/**
 * Register a custom channel without modifying this file.
 * Channels are tried by prefix match before the IC fallback.
 */
export function registerChannel(channel: Channel): void {
  extraChannels.push(channel)
}

// ── Per-player state ──────────────────────────────────────────────────────────

const playerHistory = new Map<number, ChatMsg[]>()
const lastMsgTime   = new Map<number, number>()

function pushHistory(userId: number, m: ChatMsg): void {
  const h = playerHistory.get(userId) ?? []
  h.push(m)
  if (h.length > MAX_HISTORY) h.shift()
  playerHistory.set(userId, h)
}

function replayHistory(mp: Mp, store: Store, userId: number): void {
  const player = store.get(userId)
  if (!player) return
  const history = playerHistory.get(userId) ?? []
  for (const m of history) {
    deliver(mp, player.actorId, m)
  }
}

// ── Delivery ──────────────────────────────────────────────────────────────────

function deliver(mp: Mp, actorId: number, m: ChatMsg): void {
  if (!actorId) return
  const payload = spansToColorString(m.text)
  safeSet(mp, actorId, CHAT_MSG_PROP, '')
  if (!safeSet(mp, actorId, CHAT_MSG_PROP, payload)) {
    console.error(`[chat] failed to deliver to actor ${actorId}`)
  }
}

// ── Proximity helper ──────────────────────────────────────────────────────────

function dist3(
  a: [number, number, number] | null,
  b: [number, number, number] | null,
): number {
  if (!a || !b) return Infinity
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)
}

function sendProximity(
  mp: Mp,
  store: Store,
  senderActorId: number,
  m: ChatMsg,
  range: number,
): void {
  const origin = safeCall(() => mp.getActorPos(senderActorId), null)
  for (const p of store.getAll()) {
    if (p.actorId === senderActorId) {
      deliver(mp, p.actorId, m)
      pushHistory(p.id, m)
      continue
    }

    const targetPos = safeCall(() => mp.getActorPos(p.actorId), null)
    if (dist3(origin, targetPos) <= range) {
      deliver(mp, p.actorId, m)
      pushHistory(p.id, m)
    }
  }
}

// ── init ──────────────────────────────────────────────────────────────────────

/** Call once after an actor becomes ready to ensure updateOwner fires. */
export function initClientChat(mp: Mp, actorId: number): void {
  safeSet(mp, actorId, CHAT_MSG_PROP, '')
}

export function init(mp: Mp): void {
  mp.makeProperty(CHAT_MSG_PROP, {
    isVisibleByOwner:    true,
    isVisibleByNeighbors: false,
    updateOwner:         signScript(UPDATE_OWNER_JS),
    updateNeighbor:      '',
  })

  console.log('[chat] property registered')
}

// ── handleChatInput ───────────────────────────────────────────────────────────
//
// Returns true  → input was consumed (chat channel, IC, or __reload__)
// Returns false → unknown /command; caller should route to command handler

export function handleChatInput(
  mp: Mp,
  store: Store,
  userId: number,
  text: string,
): boolean {
  if (text === '__reload__') {
    replayHistory(mp, store, userId)
    return true
  }

  const player = store.get(userId)
  if (!player) return true

  const raw = text.trim().replace(/[\x00-\x1F\x7F]/g, '')
  if (!raw || raw.length > MAX_MSG_LEN) return true

  const now = Date.now()
  const last = lastMsgTime.get(userId) ?? 0
  if (now - last < RATE_LIMIT_MS) {
    const rateMsg = mkMsg('plain',
      sp('[System] ', C.nameSystem, ['nonrp']),
      sp('Please wait before sending another message.', C.system, ['nonrp', 'text']),
    )
    deliver(mp, player.actorId, rateMsg)
    return true
  }
  lastMsgTime.set(userId, now)

  const lower = raw.toLowerCase()
  const ctx: ChannelContext = { mp, store, userId, text: raw, player }

  // ── /me ───────────────────────────────────────────────────────────────────
  if (lower.startsWith('/me ')) {
    const action = raw.slice(4).trim()
    if (!action) return true
    const m = mkMsg('rp',
      sp('* ', C.tagIc, ['nonrp']),
      sp(player.name, C.nameIc, ['nonrp']),
      sp(' ' + action + ' *', C.msgMe, ['rp']),
    )
    sendProximity(mp, store, player.actorId, m, SAY_RANGE)
    console.log(`[chat:me] ${player.name} ${action}`)
    return true
  }

  // ── /ooc ──────────────────────────────────────────────────────────────────
  if (lower.startsWith('/ooc ') || lower === '/ooc') {
    const body = raw.slice(5).trim()
    if (!body) return true
    const m = mkMsg('plain',
      sp('[OOC] ', C.tagOoc, ['nonrp']),
      sp(player.name + ': ', C.nameOoc, ['nonrp']),
      sp(body, C.msgOoc, ['nonrp', 'text']),
    )
    for (const p of store.getAll()) {
      deliver(mp, p.actorId, m)
      pushHistory(p.id, m)
    }
    console.log(`[chat:ooc] ${player.name}: ${body}`)
    return true
  }

  // ── /w <name> <text> ──────────────────────────────────────────────────────
  if (lower.startsWith('/w ')) {
    const rest     = raw.slice(3).trim()
    const spaceIdx = rest.indexOf(' ')
    if (spaceIdx === -1) return true
    const targetName = rest.slice(0, spaceIdx).toLowerCase()
    const body       = rest.slice(spaceIdx + 1).trim()
    if (!body) return true

    const target = store.getAll().find(p => p.name.toLowerCase() === targetName)
    if (!target) {
      const notFound = mkMsg('plain',
        sp('[Whisper] ', C.tagWhisper, ['nonrp']),
        sp(`Player "${rest.slice(0, spaceIdx)}" is not online.`, C.system, ['nonrp', 'text']),
      )
      deliver(mp, player.actorId, notFound)
      return true
    }

    const d = dist3(
      safeCall(() => mp.getActorPos(player.actorId), null),
      safeCall(() => mp.getActorPos(target.actorId), null),
    )
    if (d > WHISPER_RANGE) {
      const tooFar = mkMsg('plain',
        sp('[Whisper] ', C.tagWhisper, ['nonrp']),
        sp('Too far away to whisper.', C.system, ['nonrp', 'text']),
      )
      deliver(mp, player.actorId, tooFar)
      return true
    }

    const toTarget = mkMsg('plain',
      sp('[Whisper] ', C.tagWhisper, ['nonrp']),
      sp(player.name + ' whispers: ', C.nameWhisper, ['nonrp']),
      sp(body, C.msgWhisper, ['text']),
    )
    const toSelf = mkMsg('plain',
      sp('[→ ' + target.name + '] ', C.tagWhisper, ['nonrp']),
      sp(body, C.msgWhisper, ['text']),
    )
    deliver(mp, target.actorId, toTarget)
    pushHistory(target.id, toTarget)
    deliver(mp, player.actorId, toSelf)
    pushHistory(player.id, toSelf)
    console.log(`[chat:whisper] ${player.name} → ${target.name}: ${body}`)
    return true
  }

  // ── /f <text> (faction chat) ──────────────────────────────────────────────
  if (lower.startsWith('/f ') || lower === '/f') {
    const body = raw.slice(3).trim()
    if (!body) return true

    if (!player.factions.length) {
      const noFaction = mkMsg('plain',
        sp('[Faction] ', C.tagFaction, ['nonrp']),
        sp('You are not in a faction.', C.system, ['nonrp', 'text']),
      )
      deliver(mp, player.actorId, noFaction)
      return true
    }

    const m = mkMsg('plain',
      sp('[Faction] ', C.tagFaction, ['nonrp']),
      sp(player.name + ': ', C.nameFaction, ['nonrp']),
      sp(body, C.msgFaction, ['text']),
    )
    for (const p of store.getAll()) {
      if (p.factions.some(f => player.factions.includes(f))) {
        deliver(mp, p.actorId, m)
        pushHistory(p.id, m)
      }
    }
    console.log(`[chat:faction] ${player.name}: ${body}`)
    return true
  }

  // ── Custom registered channels ────────────────────────────────────────────
  for (const ch of extraChannels) {
    const prefix = ch.prefix.toLowerCase()
    if (prefix && matchesChannelPrefix(lower, prefix)) {
      ch.handle({ ...ctx, text: raw.slice(ch.prefix.length).trim() })
      return true
    }
  }

  // ── Unknown /command → let caller route ───────────────────────────────────
  if (raw.startsWith('/')) return false

  // ── IC (proximity speech, default) ────────────────────────────────────────
  const m = mkMsg('plain',
    sp(player.name + ': ', C.nameIc, ['text']),
    sp(raw, C.msgIc, ['text']),
  )
  sendProximity(mp, store, player.actorId, m, SAY_RANGE)
  console.log(`[chat:ic] ${player.name}: ${raw}`)
  return true
}

// ── Named API ─────────────────────────────────────────────────────────────────

/** Send a styled [System] message to a single player. */
export function sendSystem(mp: Mp, store: Store, userId: number, text: string): void {
  const player = store.get(userId)
  if (!player) return
  const m = mkMsg('plain',
    sp('[System] ', C.nameSystem, ['nonrp']),
    sp(text, C.system, ['nonrp', 'text']),
  )
  deliver(mp, player.actorId, m)
  pushHistory(userId, m)
}

/** Broadcast a styled [System] message to all connected players. */
export function broadcastSystem(mp: Mp, store: Store, text: string): void {
  const m = mkMsg('plain',
    sp('[System] ', C.nameSystem, ['nonrp']),
    sp(text, C.system, ['nonrp', 'text']),
  )
  for (const p of store.getAll()) {
    deliver(mp, p.actorId, m)
    pushHistory(p.id, m)
  }
  console.log(`[chat:system] ${text}`)
}

/**
 * Send a plain-text message to a single player.
 * Kept for backward compatibility with other systems.
 */
export function sendToPlayer(
  mp: Mp,
  store: Store,
  userId: number,
  text: string,
  color = '#ffffff',
): void {
  const player = store.get(userId)
  if (!player) return
  const m = mkMsg('plain', sp(text, color, ['text']))
  deliver(mp, player.actorId, m)
  pushHistory(userId, m)
}

/** Broadcast a plain-text message to all connected players. */
export function broadcast(mp: Mp, store: Store, text: string, color = '#ffffff'): void {
  const m = mkMsg('plain', sp(text, color, ['text']))
  for (const p of store.getAll()) {
    deliver(mp, p.actorId, m)
    pushHistory(p.id, m)
  }
}
