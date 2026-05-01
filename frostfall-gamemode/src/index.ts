// ── Frostfall Roleplay — Entry Point ─────────────────────────────────────────
// Wires all systems together and hands control to the SkyMP runtime.

import { store }    from './core/store'
import { bus }      from './core/bus'
import { getUserDisplayName, safeGet } from './core/mpUtil'
import { runGlobalProbes } from './tests/probeGlobals'
import * as chat      from './systems/communication/chat'
import * as courier   from './systems/communication/courier'
import * as hunger    from './systems/survival/hunger'
import * as drunkBar  from './systems/survival/drunkBar'
import * as economy   from './systems/economy/economy'
import * as bounty    from './systems/social/bounty'
import * as factions  from './systems/social/factions'
import * as housing   from './systems/social/housing'
import * as combat    from './systems/combat/combat'
import * as captivity from './systems/combat/captivity'
import * as prison    from './systems/justice/prison'
import * as college   from './systems/education/college'
import * as skills    from './systems/education/skills'
import * as training  from './systems/education/training'
import * as commands  from './commands'
import type { Mp }    from './types'

const CHAT_BROWSER_EVENT = 'cef::chat:send'

export function init(mp: Mp): void {
  console.log('[gamemode] Frostfall Roleplay — initializing')

  // ── Dev probe: set PROBE_GLOBALS=1 to check what SkyMP's Chakra exposes ───
  if ((globalThis as any).process?.env?.PROBE_GLOBALS === '1') {
    runGlobalProbes().catch((err: any) =>
      console.error('[probe] unhandled error: ' + String(err?.message ?? err)),
    )
  }

  // ── Chat must be first — other systems may send messages during init ──────
  chat.init(mp)

  // handleCommand is assigned once commands are registered later in this function.
  // The customPacket handler (below) captures it by reference.
  let handleCommand: ((userId: number, text: string) => void) | null = null

  // ── System init (courier before housing/prison so notifications work) ─────
  hunger.init(mp, store, bus)
  drunkBar.init(mp, store, bus)
  economy.init(mp, store, bus)
  courier.init(mp, store, bus)
  housing.init(mp, store, bus)
  bounty.init(mp, store, bus)
  combat.init(mp, store, bus)
  captivity.init(mp, store, bus)
  prison.init(mp, store, bus)
  factions.init(mp, store, bus)
  college.init(mp, store, bus)
  skills.init(mp, store, bus)
  training.init(mp, store, bus)

  // ── Command layer ─────────────────────────────────────────────────────────
  const { handle: _handleCommand } = commands.registerAll(mp, store, bus)
  handleCommand = _handleCommand

  const dispatchChatText = (userId: number, text: unknown): void => {
    const value = String(text || '').trim().slice(0, chat.MAX_MSG_LEN)
    if (!value) return
    if (value.startsWith('/')) console.log(`[chat] command input from ${userId}: ${value}`)
    if (!chat.handleChatInput(mp, store, userId, value)) {
      handleCommand?.(userId, value)
    }
  }

  // ── Player lifecycle ──────────────────────────────────────────────────────
  mp.on('connect', (userId) => {
    const tryFinishConnect = (attempt = 0) => {
      try {
        const actorId = mp.getUserActor(userId);

        // Actor is not ready yet — retry shortly.
        if (!actorId) {
          if (attempt < 20) {
            return setTimeout(() => tryFinishConnect(attempt + 1), 250);
          }
          console.error(`[gamemode] connect error for ${userId}: actor never became ready (actorId=0)`);
          return;
        }

        const name = getUserDisplayName(mp, userId, actorId);

        // Prevent duplicate registration if the retry fires after they already got registered.
        const existing = store.get(userId);
        if (existing && existing.actorId) {
          console.log(`[gamemode] ${name} (${userId}) already initialized, skipping duplicate connect`);
          return;
        }

        store.register(userId, actorId, name);
        store.update(userId, {
          profileId: safeGet<number | null>(mp, actorId, 'private.frostfallProfileId', null),
          discordId: safeGet<string | null>(mp, actorId, 'private.frostfallDiscordId', null),
        });
        console.log(`[gamemode] ${name} (${userId}) connected`);

        // Restore per-system state in dependency order
        hunger.onConnect(mp, store, bus, userId);
        drunkBar.onConnect(mp, store, bus, userId);
        economy.onConnect(mp, store, bus, userId);
        bounty.onConnect(mp, store, bus, userId);
        factions.onConnect(mp, store, bus, userId);
        housing.onConnect(mp, store, bus, userId);
        college.onConnect(mp, store, bus, userId);
        skills.onConnect(mp, store, bus, userId);
        courier.onConnect(mp, store, bus, userId);

        // Trigger the chat property so updateOwner fires and the client browser
        // mounts the chat widget.
        chat.initClientChat(mp, actorId);
      }
      catch (err: any) {
        console.error(`[gamemode] connect error for ${userId}: ${err.message}`);
      }
    };
    tryFinishConnect();
  });

  mp.on('disconnect', (userId: number) => {
    try {
      const player = store.get(userId)
      if (player) console.log(`[gamemode] ${player.name} (${userId}) disconnected`)
      skills.onSkillPlayerDisconnect(mp, userId)
      store.deregister(userId)
    } catch (err: any) {
      console.error(`[gamemode] disconnect error for ${userId}: ${err.message}`)
    }
  })

  // ── Chat input from the browser ───────────────────────────────────────────
  // The skymp5-front Chat widget calls window.mp.send('cef::chat:send', text),
  // which App.js routes to window.skyrimPlatform.sendMessage, and the SkyMP
  // client forwards as a customPacket { type, data } to the server.
  mp.on('customPacket', (userId: number, content: string) => {
    try {
      const packet = JSON.parse(content)
      if (packet.type !== CHAT_BROWSER_EVENT) return
      dispatchChatText(userId, packet.data)
    } catch (err: any) {
      console.error(`[chat] customPacket error: ${err.message}`)
    }
  })

  console.log('[gamemode] Frostfall Roleplay — ready')
}

// ── SkyMP runtime bootstrap ───────────────────────────────────────────────────
// The server sets globalThis.mp before require()-ing this file and never calls
// init() itself — so we self-execute here using the global mp object.
init((globalThis as any).mp as Mp)
