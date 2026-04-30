// ── Factions ──────────────────────────────────────────────────────────────────

import * as worldStore from '../../core/worldStore'
import { safeGet, safeSendCustomPacket, safeSet } from '../../core/mpUtil'
import type { Mp, Store, Bus, FactionMembership, FactionDocument } from '../../types'

// ── Actions ───────────────────────────────────────────────────────────────────

export function getFactionDocument(mp: Mp, factionId: string): FactionDocument | null {
  const docs = worldStore.get<Record<string, FactionDocument>>('ff_faction_docs') ?? {}
  return docs[factionId] ?? null
}

export function setFactionDocument(mp: Mp, doc: FactionDocument): void {
  const docs = worldStore.get<Record<string, FactionDocument>>('ff_faction_docs') ?? {}
  docs[doc.factionId] = Object.assign({}, doc, { updatedAt: Date.now() })
  worldStore.set('ff_faction_docs', docs)
}

export function joinFaction(mp: Mp, store: Store, bus: Bus, playerId: number, factionId: string, rank?: number): boolean {
  const player = store.get(playerId)
  if (!player) return false

  const joinRank     = rank ?? 0
  const memberships  = _getMemberships(mp, player.actorId)
  const existingIdx  = memberships.findIndex(m => m.factionId === factionId)

  if (existingIdx >= 0) {
    memberships[existingIdx].rank = joinRank
  } else {
    memberships.push({ factionId, rank: joinRank, joinedAt: Date.now() })
  }

  _saveMemberships(mp, player.actorId, memberships)

  const factionIds = memberships.map(m => m.factionId)
  store.update(playerId, { factions: factionIds })

  bus.dispatch({ type: 'factionJoined', playerId, factionId, rank: joinRank })
  return true
}

export function leaveFaction(mp: Mp, store: Store, bus: Bus, playerId: number, factionId: string): boolean {
  const player = store.get(playerId)
  if (!player) return false

  const memberships = _getMemberships(mp, player.actorId)
  const filtered    = memberships.filter(m => m.factionId !== factionId)
  _saveMemberships(mp, player.actorId, filtered)

  const factionIds = filtered.map(m => m.factionId)
  store.update(playerId, { factions: factionIds })

  bus.dispatch({ type: 'factionLeft', playerId, factionId })
  return true
}

export function isFactionMember(mp: Mp, store: Store, playerId: number, factionId: string): boolean {
  const player = store.get(playerId)
  if (!player) return false
  return player.factions.includes(factionId)
}

export function getPlayerFactionRank(mp: Mp, store: Store, playerId: number, factionId: string): number | null {
  const player = store.get(playerId)
  if (!player) return null
  const memberships = _getMemberships(mp, player.actorId)
  const m = memberships.find(m => m.factionId === factionId)
  return m ? m.rank : null
}

export function getPlayerMemberships(mp: Mp, store: Store, playerId: number): FactionMembership[] {
  const player = store.get(playerId)
  if (!player) return []
  return _getMemberships(mp, player.actorId)
}

export function refreshBackendMemberships(mp: Mp, store: Store, playerId: number, accessPayload: any): FactionMembership[] {
  const player = store.get(playerId)
  if (!player) return []
  safeSet(mp, player.actorId, 'private.frostfallAccess', accessPayload || { permissions: [], gameFactions: [], factions: [] })
  const memberships = _syncBackendMemberships(mp, player.actorId)
  store.update(playerId, { factions: memberships.map(m => m.factionId) })
  safeSendCustomPacket(mp, player.actorId, 'factionsSync', { memberships })
  return memberships
}

// ── Internal ──────────────────────────────────────────────────────────────────

function _getMemberships(mp: Mp, actorId: number): FactionMembership[] {
  return safeGet<FactionMembership[]>(mp, actorId, 'ff_memberships', [])
}

function _saveMemberships(mp: Mp, actorId: number, memberships: FactionMembership[]): void {
  safeSet(mp, actorId, 'ff_memberships', memberships)
}

// ── Init ─────────────────────────────────────────────────────────────────────

export function init(mp: Mp, store: Store, bus: Bus): void {
  console.log('[factions] Initializing')
  mp.makeProperty('ff_memberships', {
    isVisibleByOwner: true,
    isVisibleByNeighbors: false,
    updateOwner: '',
    updateNeighbor: '',
  })
  console.log('[factions] Started')
}

export function onConnect(mp: Mp, store: Store, bus: Bus, userId: number): void {
  const player = store.get(userId)
  if (!player || !player.actorId) return
  const memberships = _syncBackendMemberships(mp, player.actorId)
  const factionIds  = memberships.map(m => m.factionId)
  store.update(userId, { factions: factionIds })
  // 3-arg sendCustomPacket is an undeclared native extension — guard so a missing
  // implementation doesn't abort the rest of the onConnect chain.
  safeSendCustomPacket(mp, player.actorId, 'factionsSync', { memberships })
}

function _syncBackendMemberships(mp: Mp, actorId: number): FactionMembership[] {
  const current = _getMemberships(mp, actorId)
  const access = safeGet<any>(mp, actorId, 'private.frostfallAccess', null)
  const backendFactions = Array.isArray(access?.gameFactions) ? access.gameFactions : []

  if (!backendFactions.length) {
    const localOnly = current.filter(m => m.source !== 'backend')
    if (localOnly.length !== current.length) _saveMemberships(mp, actorId, localOnly)
    return localOnly
  }

  const now = Date.now()
  const backend = backendFactions
    .filter((item: any) => typeof item?.factionId === 'string' && item.factionId)
    .map((item: any) => ({
      factionId: item.factionId,
      rank: Number.isFinite(Number(item.rank)) ? Number(item.rank) : 0,
      joinedAt: now,
      source: 'backend' as const,
      title: typeof item.title === 'string' ? item.title : undefined,
      permission: typeof item.permission === 'string' ? item.permission : undefined,
      scope: typeof item.scope === 'string' ? item.scope : undefined,
      group: typeof item.group === 'string' ? item.group : undefined,
    }))

  const backendIds = new Set(backend.map((m: FactionMembership) => m.factionId))
  const local = current.filter(m => m.source !== 'backend' && !backendIds.has(m.factionId))
  const next = [...local, ...backend]
  _saveMemberships(mp, actorId, next)
  return next
}
