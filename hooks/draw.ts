// How the board is drawn: one SVG, a space scene. An orange alien flies a UFO in the middle, each kind of work is a
// planet on the ring around it, and every call is a small rocket that leaves the ship, docks at its planet while the
// call runs and flies home when it ends. Nothing here touches the engine.
//
// Everything drawn stays inside what the terminal painter reads (raster.ts): rects, circles, ellipses, lines, paths
// and text; animations of opacity, r and stroke-dashoffset, straight animateMotion and rotating groups. Expressions
// and glances are crossfades of opacity, so they read the same in the desktop pane and in a terminal picture.
import type { Board, Entry, StationId } from '../types'
import { shortModel } from './classify'
import { DARK } from './palette'
import type { Palette } from './palette'
import { STATIONS } from './setup'
import type { Setup } from './setup'

const W = 460
const H = 430
/** Height over width of the drawing, for a surface that sizes it itself. */
export const MAP_ASPECT = H / W
const CX = 230
const CY = 212
const RX = 176
const RY = 164
/** A planet's radius. */
const NODE = 19
/** How much bigger than its drawn size the ship is shown. */
const SHIP = 1.32
/** The context ring around the ship. */
const RING = 84
/** The saucer's rim, where rockets leave and land, as shown. */
const SAUCER = { x: CX, y: CY + 12 * SHIP, rx: 54 * SHIP, ry: 10 * SHIP }
/** The saucer as drawn, before it is scaled up. */
const DECK = { x: CX, y: CY + 12, rx: 54, ry: 10 }

const FONT = 'font-family="SF Mono, ui-monospace, Menlo, monospace"'

// The braille map keeps these times too, so that the two drawings of one board light and fade together.
export const PULSE_MS = 800
export const GLOW_MS = 3200
export const ALARM_MS = 6000
export const SWITCH_MS = 8000
export const DONE_MS = 1100
/** How long a rocket takes between the ship and a planet, each way. */
export const ROCKET_MS = 1300
/** How long the alien celebrates an answer. */
const CHEER_MS = 4500
/** After this long with nothing going on, the alien dozes off. */
const NAP_MS = 120_000
/** One round of the alien looking about at the planets. */
const LOOK_MS = 14_000
const TRAIL_STOPS = 7
/** A leg of the route stays for a while after it was drawn, then fades: the route shows where the work is going, and the spokes keep where it went. */
export const TRAIL_HOLD_MS = 40_000
export const TRAIL_FADE_MS = 20_000

/** The space itself, the same whatever the theme: words stay light on it. */
const SPACE = '#070b18'
const SKIN = { main: '#d97757', shade: '#b85c3e', tip: '#f4a582', brow: '#6e2f1c', mouth: '#5a2414', eye: '#fff6ef', pupil: '#1a1020' }

type Point = { x: number; y: number }

/** The angle of place `i` on a ring turned `shift` places. */
const turn = (i: number, shift: number): number => ((i + shift) * 2 * Math.PI) / STATIONS.length
const at = (a: number, f = 1): Point => ({ x: CX + RX * f * Math.sin(a), y: CY - RY * f * Math.cos(a) })
const place = (i: number, shift: number): Point => at(turn(i, shift))
const indexOf = (id: StationId): number => STATIONS.findIndex(s => s.id === id)

const n1 = (v: number): string => (Math.round(v * 10) / 10).toString()
/** A moment on the drawing's own clock, which starts at zero each time it is drawn; a past moment is negative. */
const clock = (ms: number): string => `${(ms / 1000).toFixed(3)}s`

/** Where a straight line from `from` to `to` meets the circle of radius `r` around `from`. */
function edge(from: Point, to: Point, r: number): Point {
  const d = Math.hypot(to.x - from.x, to.y - from.y) || 1
  return { x: from.x + ((to.x - from.x) * r) / d, y: from.y + ((to.y - from.y) * r) / d }
}

/** Where the line from the saucer's middle towards `to` leaves its rim. */
function rim(to: Point): Point {
  const a = Math.atan2(to.y - SAUCER.y, to.x - SAUCER.x)
  return { x: SAUCER.x + SAUCER.rx * Math.cos(a), y: SAUCER.y + SAUCER.ry * Math.sin(a) }
}

/** The same line moved sideways, so that several rockets on one lane fly side by side. */
function aside(a: Point, b: Point, off: number): [Point, Point] {
  const d = Math.hypot(b.x - a.x, b.y - a.y) || 1
  const dx = (-(b.y - a.y) * off) / d
  const dy = ((b.x - a.x) * off) / d
  return [{ x: a.x + dx, y: a.y + dy }, { x: b.x + dx, y: b.y + dy }]
}

const poly = (pts: readonly Point[], close = true): string =>
  pts.map((p, k) => `${k === 0 ? 'M' : 'L'}${n1(p.x)} ${n1(p.y)}`).join('') + (close ? 'Z' : '')

/** A seeded random, so the stars stand still from one drawing to the next. */
function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

// ---- light ------------------------------------------------------------------------------------
//
// The look is lit, as if rendered: every round thing has a gradient for its body, a soft dark side, a bright spot where
// the light from the upper left strikes it, and a thin rim of light on its edge. Gradients are in the drawing's own
// units, so they travel with what they paint.

/** A stop of a gradient: where, what color, how opaque. */
type Stop = [number, string, number?]

/** Gradients the drawing has defined so far, written once at its top. */
let DEFS: string[] = []
let DEFINED = new Set<string>()

const stopsOf = (stops: Stop[]): string =>
  stops.map(([o, color, a]) => `<stop offset="${Math.round(o * 1000) / 1000}" stop-color="${color}"${a !== undefined && a !== 1 ? ` stop-opacity="${Math.round(a * 1000) / 1000}"` : ''}/>`).join('')

/** A gradient out from `f` (or the centre) to the circle at `c` of radius `r`, for `fill="url(#id)"`. */
function radialDef(id: string, c: Point, r: number, stops: Stop[], f?: Point): string {
  const focus = f === undefined ? '' : ` fx="${n1(f.x)}" fy="${n1(f.y)}"`
  return `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${n1(c.x)}" cy="${n1(c.y)}" r="${n1(r)}"${focus}>${stopsOf(stops)}</radialGradient>`
}

/** A gradient along the line from `a` to `b`. */
function linearDef(id: string, a: Point, b: Point, stops: Stop[]): string {
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n1(a.x)}" y1="${n1(a.y)}" x2="${n1(b.x)}" y2="${n1(b.y)}">${stopsOf(stops)}</linearGradient>`
}

/** Defines a gradient for the drawing and answers how a fill names it. */
function lit(def: string, isShared = false): string {
  const id = /id="([^"]+)"/.exec(def)?.[1] ?? ''
  if (!DEFINED.has(id)) {
    DEFINED.add(id)
    ;(isShared ? SHARED : DEFS).push(def)
    KNOWN_DEFS.set(id, [def, isShared])
  }
  return `url(#${id})`
}

/** A color moved towards white (f > 0) or black (f < 0). */
function tint(hex: string, f: number): string {
  const v = Number.parseInt(hex.slice(1), 16)
  const to = f > 0 ? 255 : 0
  const k = Math.abs(f)
  const ch = (shift: number): string => Math.round(((v >> shift) & 255) + (to - ((v >> shift) & 255)) * k).toString(16).padStart(2, '0')
  return `#${ch(16)}${ch(8)}${ch(0)}`
}

/** Gradients laid out in fractions of the shape they fill, so one serves every shape that looks alike. Written once at the top. */
let SHARED: string[] = []

/** A short id from what a gradient is, so two alike are one. */
function hashOf(text: string): string {
  let h = 2166136261
  for (let k = 0; k < text.length; k++) h = Math.imul(h ^ text.charCodeAt(k), 16777619)
  return `g${(h >>> 0).toString(36)}`
}

/** A gradient in the fractions of the box around what it fills, from the focus `f` (or the centre) out to the circle at `c`, radius `r`. */
function boxRadial(stops: Stop[], c: [number, number] = [0.5, 0.5], r = 0.5, f?: [number, number]): string {
  const focus = f === undefined ? '' : ` fx="${f[0]}" fy="${f[1]}"`
  const body = `cx="${c[0]}" cy="${c[1]}" r="${r}"${focus}>${stopsOf(stops)}`
  return share(`<radialGradient id="ID" ${body}</radialGradient>`)
}

/** A gradient in the fractions of the box around what it fills, along the line from (x1, y1) to (x2, y2). */
function boxLinear(stops: Stop[], x1: number, y1: number, x2: number, y2: number): string {
  return share(`<linearGradient id="ID" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stopsOf(stops)}</linearGradient>`)
}

function share(template: string): string {
  const id = hashOf(template)
  if (!DEFINED.has(id)) {
    const def = template.replace('id="ID"', `id="${id}"`)
    DEFINED.add(id)
    SHARED.push(def)
    KNOWN_DEFS.set(id, [def, true])
  }
  return `url(#${id})`
}

/** Every gradient ever defined, by id, so a part drawn once can bring its gradients into a later drawing. */
const KNOWN_DEFS = new Map<string, [string, boolean]>()

/** Parts that look the same in every drawing (the sky, the planets), made once and kept. */
const ONCE = new Map<string, string>()

/** A part made once for `key` and kept, its gradients brought into each drawing that uses it. */
function once(key: string, make: () => string): string {
  let svg = ONCE.get(key)
  if (svg === undefined) {
    svg = make()
    ONCE.set(key, svg)
  }
  for (const [, id] of svg.matchAll(/url\(#([\w-]+)\)/g)) {
    const known = KNOWN_DEFS.get(id as string)
    if (known === undefined || DEFINED.has(id as string)) continue
    DEFINED.add(id as string)
    ;(known[1] ? SHARED : DEFS).push(known[0])
  }
  return svg
}

/** An id safe for a gradient, from anything. */
const idOf = (...parts: (string | number)[]): string => parts.join('-').replace(/[^\w-]/g, '_')

// ---- planets ------------------------------------------------------------------------------------

type Look = {
  /** The planet's own color, for its lane, its glow and its count. */
  accent: string
  base: string
  /** What lies on the disc, in its own units: the disc has radius 1 and its centre at 0, 0. */
  bands?: [number, number, string, number?][]
  spots?: [number, number, number, number, string, number?][]
  craters?: [number, number, number][]
  craterColor?: [string, string]
  blobs?: [[number, number][], string, number?][]
  cracks?: [[number, number][], string, number][]
  /** A ring around the planet: its radii and its tilt in degrees. */
  ring?: { rx: number; ry: number; tilt: number; color: string; inner: string }
  /** A thin halo of air. */
  air?: string
  /** How strongly the light shines off it, 0 to 1. */
  gloss?: number
}

const LOOKS: Record<StationId, Look> = {
  // Earth: you.
  you: {
    accent: '#6fb7ff',
    base: '#2266cf',
    blobs: [
      [[[-0.78, -0.25], [-0.45, -0.62], [-0.08, -0.45], [-0.18, -0.12], [-0.42, 0.08], [-0.66, 0.02]], '#3f9b4c'],
      [[[0.08, 0.12], [0.5, -0.12], [0.78, 0.18], [0.6, 0.55], [0.25, 0.62], [0.12, 0.38]], '#3f9b4c'],
      [[[0.28, -0.6], [0.52, -0.66], [0.6, -0.44], [0.38, -0.38]], '#4caf50'],
    ],
    spots: [
      [0, -0.88, 0.42, 0.13, '#f4f8ff', 0.95],
      [-0.25, 0.38, 0.48, 0.07, '#ffffff', 0.75],
      [0.3, -0.18, 0.38, 0.06, '#ffffff', 0.6],
    ],
    air: '#8fc7ff',
  },
  // Jupiter: the model.
  model: {
    accent: '#e8b98a',
    base: '#d8b78a',
    bands: [
      [-0.82, -0.62, '#b07a4f'],
      [-0.38, -0.22, '#ecdcbc'],
      [-0.06, 0.12, '#a86a42'],
      [0.34, 0.48, '#e6cfa7'],
      [0.64, 0.8, '#b98557'],
    ],
    spots: [[0.32, 0.28, 0.27, 0.15, '#c1543a']],
  },
  // Neptune: memory.
  memory: {
    accent: '#7c9bff',
    base: '#2f50c8',
    bands: [
      [-0.46, -0.34, '#4d72ee', 0.8],
      [0.26, 0.34, '#4d72ee', 0.6],
    ],
    spots: [
      [-0.24, 0.04, 0.26, 0.14, '#1a2c82'],
      [0.22, -0.6, 0.3, 0.05, '#e8eeff', 0.85],
    ],
    air: '#8aa6ff',
  },
  // Mars: files.
  files: {
    accent: '#e2774f',
    base: '#b8462a',
    blobs: [[[[-0.7, 0.2], [-0.2, 0.05], [0.4, 0.25], [0.6, 0.5], [0.0, 0.62], [-0.55, 0.5]], '#9a3820', 0.8]],
    craters: [
      [-0.36, -0.22, 0.18],
      [0.38, 0.12, 0.14],
      [0.14, -0.5, 0.1],
      [-0.08, 0.5, 0.1],
    ],
    craterColor: ['#8e321c', '#c9583a'],
    spots: [[0, -0.86, 0.34, 0.13, '#f4ede6']],
    gloss: 0.22,
  },
  // A lava world: the shell.
  shell: {
    accent: '#ff8a3d',
    base: '#2b1814',
    cracks: [
      [[[-0.86, -0.2], [-0.42, -0.06], [-0.2, -0.4], [0.18, -0.2], [0.62, -0.34], [0.86, -0.22]], '#ff7a2e', 1.3],
      [[[-0.66, 0.42], [-0.3, 0.3], [0.0, 0.56], [0.4, 0.36], [0.74, 0.48]], '#ff9a3d', 1.1],
      [[[0.06, -0.06], [-0.02, 0.36]], '#ffb24d', 0.9],
    ],
    spots: [
      [0.36, -0.56, 0.1, 0.1, '#ffc266'],
      [-0.5, 0.1, 0.07, 0.07, '#ffb24d'],
    ],
    gloss: 0.25,
    air: '#ff7a2e',
  },
  // Saturn: the network.
  web: {
    accent: '#ead9a0',
    base: '#e3cf94',
    bands: [
      [-0.62, -0.46, '#cdb06a'],
      [-0.16, -0.02, '#f0e2b6'],
      [0.22, 0.42, '#c9a962'],
      [0.6, 0.72, '#d8c17f'],
    ],
    ring: { rx: 1.72, ry: 0.42, tilt: -18, color: '#cdb277', inner: '#8e7a4e' },
  },
  // An ice moon: the browser.
  browser: {
    accent: '#bfe3f2',
    base: '#d6ecf6',
    cracks: [
      [[[-0.76, -0.42], [-0.3, -0.24], [0.1, -0.36], [0.6, -0.16]], '#8db6cc', 0.9],
      [[[-0.6, 0.36], [-0.2, 0.16], [0.24, 0.3], [0.7, 0.18]], '#8db6cc', 0.9],
      [[[0.12, -0.84], [0.02, -0.2], [0.22, 0.5]], '#a7c8da', 0.8],
    ],
    craters: [[0.4, 0.12, 0.11]],
    craterColor: ['#b4d2e2', '#e4f3fa'],
    gloss: 0.7,
  },
  // A violet gas giant: agents. Its moons are the subagents at work.
  agents: {
    accent: '#b796f0',
    base: '#6e45b8',
    bands: [
      [-0.66, -0.46, '#8c65d2'],
      [-0.12, 0.06, '#5a3699'],
      [0.3, 0.5, '#9d7adf', 0.8],
    ],
    spots: [[-0.24, -0.06, 0.36, 0.12, '#c2a6f5', 0.55]],
  },
  // Uranus: skills.
  skills: {
    accent: '#7fe0d3',
    base: '#68cfc4',
    bands: [
      [-0.3, -0.2, '#86e2d8', 0.7],
      [0.32, 0.4, '#58bdb2', 0.7],
    ],
    ring: { rx: 1.62, ry: 0.3, tilt: 80, color: '#a7efe6', inner: '#5fb8ae' },
  },
  // The Moon: hooks.
  hooks: {
    accent: '#c9c9ce',
    base: '#9a9a9f',
    blobs: [
      [[[-0.6, -0.4], [-0.2, -0.5], [0.0, -0.2], [-0.3, 0.0], [-0.6, -0.1]], '#7c7c82'],
      [[[0.1, 0.2], [0.45, 0.1], [0.6, 0.4], [0.3, 0.6], [0.05, 0.45]], '#808086'],
    ],
    craters: [
      [0.42, -0.42, 0.14],
      [-0.42, 0.42, 0.12],
      [0.1, -0.7, 0.08],
    ],
    craterColor: ['#85858b', '#b1b1b6'],
    gloss: 0.2,
  },
}

/** The half of a ring behind the planet or the half in front of it: two lit bands with a gap between. */
function ringHalf(p: Point, look: Look, front: boolean, key: string): string {
  const ring = look.ring
  if (ring === undefined) return ''
  const t = (ring.tilt * Math.PI) / 180
  const turn = (x: number, y: number): Point => ({ x: p.x + x * Math.cos(t) - y * Math.sin(t), y: p.y + x * Math.sin(t) + y * Math.cos(t) })
  const half = (k: number): Point[] => {
    const pts: Point[] = []
    for (let j = 0; j <= 28; j++) {
      const a = (front ? 0 : Math.PI) + (Math.PI * j) / 28
      pts.push(turn(ring.rx * NODE * k * Math.cos(a), ring.ry * NODE * k * Math.sin(a)))
    }
    return pts
  }
  // Lit across its length: bright where it faces the light, darker at its far end and on the back half.
  const ends = [turn(-ring.rx * NODE, 0), turn(ring.rx * NODE, 0)] as const
  const fill = lit(
    linearDef(idOf('ring', key, front ? 'f' : 'b', Math.round(p.x), Math.round(p.y)), ends[0], ends[1], [
      [0, tint(ring.color, 0.35)],
      [0.45, ring.color],
      [1, tint(ring.color, front ? -0.45 : -0.6)],
    ]),
  )
  const band = (outer: number, inner: number, opacity: number): string =>
    `<path d="${poly([...half(outer), ...half(inner).reverse()])}" fill="${fill}" opacity="${opacity}"/>`
  return band(1, 0.84, front ? 0.95 : 0.75) + band(0.8, 0.64, front ? 0.6 : 0.45)
}

/** A planet, lit: its glow of air, its disc and what lies on it, then light and shade over it all. Its ring's back half is drawn by the caller, before it. */
function planet(p: Point, look: Look, key: string): { glow: string; body: string } {
  const R = NODE
  const u = (x: number, y: number): Point => ({ x: p.x + x * R, y: p.y + y * R })
  // A halo of air, faint for most, stronger for the planets that have air.
  const air = look.air ?? look.accent
  const glow = `<circle cx="${n1(p.x)}" cy="${n1(p.y)}" r="${n1(R * 1.5)}" fill="${boxRadial([
    [0.6, air, 0],
    [0.68, air, look.air !== undefined ? 0.45 : 0.22],
    [1, air, 0],
  ])}"/>`
  // The disc itself is lit from the upper left: lighter there, deeper at the far edge.
  let out = `<circle cx="${n1(p.x)}" cy="${n1(p.y)}" r="${R}" fill="${boxRadial(
    [
      [0, tint(look.base, 0.18)],
      [0.55, look.base],
      [1, tint(look.base, -0.35)],
    ],
    [0.35, 0.325],
    0.725,
  )}"/>`
  for (const [y1, y2, color, opacity] of look.bands ?? []) {
    // A band runs edge to edge: its outline follows the disc's own edge between its two heights.
    const side = (y: number): number => Math.sqrt(Math.max(0, 1 - y * y))
    const pts: Point[] = []
    for (let k = 0; k <= 6; k++) {
      const y = y1 + ((y2 - y1) * k) / 6
      pts.push(u(side(y), y))
    }
    for (let k = 6; k >= 0; k--) {
      const y = y1 + ((y2 - y1) * k) / 6
      pts.push(u(-side(y), y))
    }
    out += `<path d="${poly(pts)}" fill="${color}"${opacity !== undefined ? ` opacity="${opacity}"` : ''}/>`
  }
  for (const [pts, color, opacity] of look.blobs ?? []) {
    out += `<path d="${poly(pts.map(([x, y]) => u(x, y)))}" fill="${color}"${opacity !== undefined ? ` opacity="${opacity}"` : ''} stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/>`
  }
  for (const [x, y, r] of look.craters ?? []) {
    const [dark, light] = look.craterColor ?? ['#000000', '#ffffff']
    const c = u(x, y)
    out +=
      `<circle cx="${n1(c.x)}" cy="${n1(c.y)}" r="${n1(r * R)}" fill="${dark}"/>` +
      `<circle cx="${n1(c.x - r * R * 0.22)}" cy="${n1(c.y - r * R * 0.22)}" r="${n1(r * R * 0.62)}" fill="${light}"/>`
  }
  for (const [pts, color, width] of look.cracks ?? []) {
    out += `<path d="${poly(pts.map(([x, y]) => u(x, y)), false)}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`
  }
  for (const [x, y, rx, ry, color, opacity] of look.spots ?? []) {
    const c = u(x, y)
    out += `<ellipse cx="${n1(c.x)}" cy="${n1(c.y)}" rx="${n1(rx * R)}" ry="${n1(ry * R)}" fill="${color}"${opacity !== undefined ? ` opacity="${opacity}"` : ''}/>`
  }
  // Over it all, the light: a night side deepening to the far edge, a thin rim of light, and a soft bright spot where it strikes.
  const disc = `cx="${n1(p.x)}" cy="${n1(p.y)}" r="${R}"`
  out += `<circle ${disc} fill="${boxRadial(
    [
      [0.42, '#000000', 0.04],
      [0.68, '#000000', 0.36],
      [0.88, '#000000', 0.68],
      [1, '#000000', 0.8],
    ],
    [0.34, 0.31],
    0.75,
  )}"/>`
  out += `<circle ${disc} fill="${boxRadial([
    [0.84, air, 0],
    [0.96, tint(air, 0.3), 0.45],
    [1, tint(air, 0.3), 0.15],
  ])}"/>`
  const gloss = look.gloss ?? 0.42
  out += `<circle ${disc} fill="${boxRadial(
    [
      [0, '#ffffff', gloss],
      [0.35, '#ffffff', gloss * 0.4],
      [1, '#ffffff', 0],
    ],
    [0.31, 0.28],
    0.31,
  )}"/>`
  return { glow, body: out }
}

// ---- rockets ------------------------------------------------------------------------------------

/**
 * A rocket's parts drawn pointing right around the origin, lit round its body, with a glass port and a hot flame. A
 * rocket is these turned to its heading: one set of gradients serves every rocket with the same nose.
 */
function rocketParts(nose: string, isHurt: boolean): { d: string; fill: string; isFlame?: boolean }[] {
  const shape = (pts: [number, number][]): string => poly(pts.map(([x, y]) => ({ x, y })))
  const hull = isHurt ? '#e8654f' : '#e8ecf8'
  const across = (stops: Stop[], w = 2.6): string => lit(linearDef(hashOf(`rk${w}${JSON.stringify(stops)}`), { x: 0, y: -w }, { x: 0, y: w }, stops), true)
  return [
    { d: shape([[-6, 1.6], [-12.5, 0], [-6, -1.6]]), fill: lit(linearDef('rk-flame', { x: -6, y: 0 }, { x: -12.5, y: 0 }, [[0, '#fff7d6'], [0.3, '#ffc35a'], [0.7, '#ff7a2e', 0.85], [1, '#ff4a1a', 0]]), true), isFlame: true },
    { d: shape([[-3, 2.3], [-7.2, 5], [-6, 2.3]]), fill: across([[0, tint(SKIN.main, 0.25)], [1, tint(SKIN.main, -0.4)]], 5) },
    { d: shape([[-3, -2.3], [-7.2, -5], [-6, -2.3]]), fill: across([[0, tint(SKIN.main, 0.25)], [1, tint(SKIN.main, -0.4)]], 5) },
    { d: shape([[8, 0], [4, 2.5], [-5, 2.5], [-6.2, 0], [-5, -2.5], [4, -2.5]]), fill: across([[0, '#ffffff'], [0.3, hull], [0.75, tint(hull, -0.3)], [1, tint(hull, -0.6)]]) },
    { d: shape([[8, 0], [4.4, 2.3], [4.4, -2.3]]), fill: across([[0, tint(nose, 0.45)], [0.4, nose], [1, tint(nose, -0.5)]], 2.3) },
    { d: shape([[1.9, 0], [1.1, 1.1], [-0.2, 1.1], [-0.9, 0], [-0.2, -1.1], [1.1, -1.1]]), fill: lit(radialDef('rk-port', { x: 0.5, y: 0 }, 1.7, [[0, '#d6edff'], [0.35, '#4f8fe0'], [1, '#173a7a']], { x: 1, y: -0.5 }), true) },
  ]
}

const headingOf = (u: Point): string => n1((Math.atan2(u.y, u.x) * 180) / Math.PI)

/** A rocket on its way from `a` to `b`, `age` ms into a trip of ROCKET_MS. */
function rocket(a: Point, b: Point, nose: string, age: number, isHurt: boolean): string {
  const d = Math.hypot(b.x - a.x, b.y - a.y) || 1
  const turn = `transform="rotate(${headingOf({ x: (b.x - a.x) / d, y: (b.y - a.y) / d })})"`
  const timing = `begin="${clock(-age)}" dur="${clock(ROCKET_MS)}" fill="freeze"`
  const motion = `<animateMotion path="M${n1(a.x)} ${n1(a.y)}L${n1(b.x)} ${n1(b.y)}" ${timing}/>`
  return rocketParts(nose, isHurt)
    .map(
      part =>
        `<path ${turn} d="${part.d}" fill="${part.fill}" opacity="0">${motion}` +
        (part.isFlame
          ? `<animate attributeName="opacity" values=".95;.45;.95;.45;.95;.45;.9;0" keyTimes="0;.14;.28;.42;.56;.7;.88;1" ${timing}/>`
          : `<animate attributeName="opacity" values="1;1;0" keyTimes="0;.9;1" ${timing}/>`) +
        `</path>`,
    )
    .join('')
}

/** A rocket parked beside its planet while the call runs, pointing back at the ship. */
function docked(p: Point, toward: Point, nose: string): string {
  const d = Math.hypot(toward.x - p.x, toward.y - p.y) || 1
  const u = { x: (p.x - toward.x) / d, y: (p.y - toward.y) / d }
  const spot = { x: p.x - u.x * (NODE + 8), y: p.y - u.y * (NODE + 8) }
  return rocketParts(nose, false)
    .filter(part => !part.isFlame)
    .map(part => `<path transform="translate(${n1(spot.x)} ${n1(spot.y)}) rotate(${headingOf(u)})" d="${part.d}" fill="${part.fill}"/>`)
    .join('')
}

/** A signal coming in from a planet to the ship: a hollow spark with a short tail. */
function spark(a: Point, b: Point, color: string, age: number): string {
  const path = `M${n1(a.x)} ${n1(a.y)}L${n1(b.x)} ${n1(b.y)}`
  let out = ''
  for (let k = 0; k <= 1; k++) {
    const timing = `begin="${clock(k * 60 - age)}" dur="${clock(PULSE_MS)}" fill="freeze"`
    out +=
      `<circle r="${n1(3.6 - k)}" fill="none" stroke="${color}" stroke-width="1.4" opacity="0">` +
      `<animateMotion path="${path}" ${timing}/>` +
      `<animate attributeName="opacity" values="1;1;0" keyTimes="0;.82;1" ${timing}/></circle>`
  }
  return out
}

// ---- the route ----------------------------------------------------------------------------------

/** How far from the centre a leg bends, by how many stations apart its ends are. */
const BEND = [0.5, 0.5, 0.4, 0.45, 0.55, 0.75]

function leg(i: number, j: number, shift: number): { path: string; end: Point } {
  const n = STATIONS.length
  let steps = (((j - i) % n) + n) % n
  if (steps > n / 2) steps -= n
  const bend = at(turn(i + steps / 2, shift), BEND[Math.abs(steps)] ?? 0.5)
  const a = edge(place(i, shift), bend, NODE + 6)
  const b = edge(place(j, shift), bend, NODE + 6)
  return { path: `M${n1(a.x)} ${n1(a.y)}Q${n1(bend.x)} ${n1(bend.y)} ${n1(b.x)} ${n1(b.y)}`, end: b }
}

/** The stations the main loop went through, oldest first, a station visited twice in a row counted once. */
export function routeOf(entries: readonly Entry[], max = TRAIL_STOPS): { station: StationId; at: number }[] {
  const stops: { station: StationId; at: number }[] = []
  for (const e of entries) {
    if (e.from === 'agents' || e.station === 'model') continue
    const last = stops[stops.length - 1]
    if (last !== undefined && last.station === e.station) last.at = e.startedAt
    else stops.push({ station: e.station, at: e.startedAt })
  }
  return stops.slice(-max)
}

function trail(entries: readonly Entry[], now: number, c: Palette, isStill: boolean, shift: number): string {
  const stops = routeOf(entries)
  let out = ''
  for (let k = 1; k < stops.length; k++) {
    const from = stops[k - 1]
    const to = stops[k]
    if (from === undefined || to === undefined) continue
    const { path, end } = leg(indexOf(from.station), indexOf(to.station), shift)
    const isHead = k === stops.length - 1
    const age = now - to.at
    if (age >= TRAIL_HOLD_MS + TRAIL_FADE_MS) continue
    const opacity = n1(0.08 + (0.32 * k) / (stops.length - 1))
    const fade = `<animate attributeName="opacity" values="${opacity};0" begin="${clock(TRAIL_HOLD_MS - age)}" dur="${clock(TRAIL_FADE_MS)}" fill="freeze"/>`
    const drawing = isHead && !isStill
      ? ` pathLength="1" stroke-dasharray="1 1" stroke-dashoffset="1"><animate attributeName="stroke-dashoffset" values="1;0" begin="${clock(to.at - now)}" dur=".5s" fill="freeze"/>`
      : '>'
    out += `<path d="${path}" fill="none" stroke="${c.trail}" stroke-width="${isHead ? 1.3 : 1}" stroke-linecap="round" opacity="${opacity}"${drawing}${fade}</path>`
    if (isHead) {
      out +=
        `<circle cx="${n1(end.x)}" cy="${n1(end.y)}" r="2.2" fill="${c.trail}" opacity="${isStill ? '.7' : '0'}">` +
        (isStill ? '' : `<animate attributeName="opacity" values="0;.7" begin="${clock(to.at - now + 400)}" dur=".15s" fill="freeze"/>`) +
        `<animate attributeName="opacity" values=".7;0" begin="${clock(TRAIL_HOLD_MS - age)}" dur="${clock(TRAIL_FADE_MS)}" fill="freeze"/></circle>`
    }
  }
  return out
}

// ---- the stations -------------------------------------------------------------------------------

type Scene = { entries: Entry[]; board: Board; now: number; c: Palette; names: Record<StationId, string>; isStill: boolean; shift: number }

function station(s: (typeof STATIONS)[number], i: number, { entries, board, now, c, names, isStill, shift }: Scene): { under: string; body: string; over: string } {
  const p = place(i, shift)
  const x = n1(p.x)
  const y = n1(p.y)
  const look = LOOKS[s.id]
  const count = board.counts[s.id] ?? 0
  const own = entries.filter(e => e.station === s.id)
  const running = own.filter(e => e.status === 'run')
  const latest = own.length > 0 ? own[own.length - 1] : undefined
  const since = latest === undefined ? Infinity : now - (latest.endedAt ?? latest.startedAt)
  const alarm = own.filter(e => e.status === 'block' || e.status === 'err').pop()
  const alarmAge = alarm === undefined ? Infinity : now - (alarm.endedAt ?? alarm.startedAt)
  const isAlarm = alarmAge < ALARM_MS
  const isLit = running.length > 0 || since < GLOW_MS
  const color = isAlarm ? c.red : look.accent
  const fade = isAlarm ? alarmAge : since
  const span = isAlarm ? ALARM_MS : GLOW_MS

  const shape = { glow: once(`glow:${s.id}:${shift}`, () => planet(p, look, s.id).glow), body: once(`planet:${s.id}:${shift}`, () => ringHalf(p, look, false, s.id) + planet(p, look, s.id).body + ringHalf(p, look, true, s.id)) }
  let under = shape.glow
  if (isLit || isAlarm) {
    // A soft light around the planet while it works, fading after.
    const halo = boxRadial([
      [0, color, 0.75],
      [0.55, color, 0.5],
      [1, color, 0],
    ])
    under +=
      running.length > 0 && !isAlarm
        ? `<circle cx="${x}" cy="${y}" r="${NODE + 16}" fill="${halo}" opacity=".55"/>`
        : `<circle cx="${x}" cy="${y}" r="${NODE + 16}" fill="${halo}" opacity="0">` +
          `<animate attributeName="opacity" values=".9;0" begin="${clock(-fade)}" dur="${clock(span)}" fill="freeze"/></circle>`
  }
  if (running.length > 0) {
    const elapsed = now - Math.min(...running.map(e => e.startedAt))
    const beat = `begin="${clock(-(elapsed % 1400))}" dur="1.4s" repeatCount="indefinite"`
    if (!isStill) {
      under +=
        `<circle cx="${x}" cy="${y}" r="${NODE + 2}" fill="none" stroke="${color}" stroke-width="1.2">` +
        `<animate attributeName="r" values="${NODE + 2};${NODE + 16}" ${beat}/>` +
        `<animate attributeName="opacity" values=".8;0" ${beat}/></circle>`
    }
    // Two hands of a clock around the planet: the inner one goes round in a minute, the outer one in ten.
    const hand = (r: number, width: number, lapMs: number, isOnce: boolean): string =>
      `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${color}" stroke-width="${width}" pathLength="1" stroke-dasharray="1 1" stroke-dashoffset="1" transform="rotate(-90 ${x} ${y})">` +
      `<animate attributeName="stroke-dashoffset" values="1;0" begin="${clock(-(isOnce ? Math.min(elapsed, lapMs) : elapsed % lapMs))}" dur="${clock(lapMs)}" ${isOnce ? 'fill="freeze"' : 'repeatCount="indefinite"'}/></circle>`
    under += hand(NODE + 5, 2, 60_000, false) + hand(NODE + 9, 1.1, 600_000, true)
  }

  const body = shape.body

  // The words stand on a rim of the space's own color, so a line that passes behind them never strikes them through.
  const rimmed = `paint-order="stroke" stroke="${SPACE}" stroke-width="3.5" stroke-linejoin="round"`
  let over = `<text x="${x}" y="${n1(p.y + NODE + 16)}" text-anchor="middle" ${FONT} font-size="11.5" ${rimmed} fill="${isLit || isAlarm ? c.bone : c.ash}">${names[s.id]}</text>`

  // Top left: how many times the planet was visited.
  const figure = count > 999 ? '999+' : String(count)
  const wide = 7 + figure.length * 6
  const tag = { x: p.x - NODE - wide + 6, y: p.y - NODE - 6 }
  over +=
    `<rect x="${n1(tag.x)}" y="${n1(tag.y)}" width="${wide}" height="13" rx="4" fill="${c.raised}" stroke="${count > 0 ? look.accent : c.line}" stroke-width=".8"/>` +
    `<text x="${n1(tag.x + wide / 2)}" y="${n1(tag.y + 9.6)}" text-anchor="middle" ${FONT} font-size="9.5" fill="${count > 0 ? look.accent : c.dim}">${figure}</text>`

  // Top right: what went wrong since the last message. Bottom right: how many run at once.
  const corner = NODE * 0.8
  const faults = board.faults?.[s.id] ?? 0
  if (faults > 0) {
    over +=
      `<circle cx="${n1(p.x + corner)}" cy="${n1(p.y - corner)}" r="7.5" fill="${c.red}"/>` +
      `<text x="${n1(p.x + corner)}" y="${n1(p.y - corner + 3.1)}" text-anchor="middle" ${FONT} font-size="9" font-weight="700" fill="${SPACE}">${faults > 99 ? '99+' : faults}</text>`
  }
  if (running.length > 1) {
    over +=
      `<circle cx="${n1(p.x + corner)}" cy="${n1(p.y + corner)}" r="8" fill="${c.raised}" stroke="${color}" stroke-width="1"/>` +
      `<text x="${n1(p.x + corner)}" y="${n1(p.y + corner + 3)}" text-anchor="middle" ${FONT} font-size="8.5" fill="${color}">×${running.length}</text>`
  }
  return { under, body, over }
}

// ---- the ship and its pilot ---------------------------------------------------------------------

/**
 * How the pilot feels, as windows of time from the moment of drawing, in ms. The pane draws again only when the board
 * changes, so a mood that ends or starts on its own (a fright, a cheer, a nap) is written into the drawing as when.
 */
type Mood = {
  isWorried: boolean
  /** Waiting on the person: lasts until the board changes. */
  isAsking: boolean
  /** Something went wrong: shows until then. 0 or less, not at all. */
  startledFor: number
  /** An answer is ready: cheers until then. */
  cheerFor: number
  /** When it dozes off, if nothing happens before; Infinity, not while this drawing stands. */
  napAt: number
  /** The planet whose work runs, to watch. */
  focus: Point | undefined
}

/**
 * Every shape in `svg` shown only between `from` and `until` ms from now; outside that its opacity is held at 0. Both
 * edges are moments, not animations that run in between, so a terminal painter sleeps until each one. A shape that
 * animates its own opacity must begin doing so at `from` or later.
 */
function windowed(svg: string, from: number, until: number): string {
  if (from <= 0 && until === Infinity) return svg
  if (until <= 0 || until <= from) return ''
  const hide = until !== Infinity ? `<animate attributeName="opacity" values="0;0" begin="${clock(until)}" dur=".001s" fill="freeze"/>` : ''
  return svg.replace(/<(circle|ellipse|path|line|rect|text)\b([^>]*?)(\/?)>/g, (_, tag: string, attrs: string, self: string) => {
    let own = attrs
    let show = ''
    if (from > 0) {
      // Unseen until it starts, then at its own opacity.
      const was = /\sopacity="([^"]*)"/.exec(attrs)?.[1] ?? '1'
      own = /\sopacity="/.test(attrs) ? attrs.replace(/\sopacity="[^"]*"/, ' opacity="0"') : `${attrs} opacity="0"`
      show = `<animate attributeName="opacity" values="${was};${was}" begin="${clock(from)}" dur=".001s" fill="freeze"/>`
    }
    return self === '/' ? `<${tag}${own}>${show}${hide}</${tag}>` : `<${tag}${own}>${show}${hide}`
  })
}

/** The alien's face, in its UFO. Glances and expressions crossfade by opacity on clocks that carry on between drawings. */
function pilot(mood: Mood, now: number, isStill: boolean, targets: Point[]): string {
  const head = { x: CX, y: CY - 8 }
  // The head is lit from the upper left like everything else; lids and blinks share its gradient.
  const HEAD = lit(radialDef('alien-head', { x: head.x - 5, y: head.y - 6 }, 24, [[0, '#ffb592'], [0.4, '#e6835f'], [0.75, '#c75f3e'], [1, '#8f3d24']]))
  const eyes = [{ x: CX - 6.2, y: CY - 9.5 }, { x: CX + 6.2, y: CY - 9.5 }]
  const toward = (p: Point, reach: number): Point => {
    const a = Math.atan2(p.y - CY, p.x - CX)
    return { x: Math.cos(a) * reach, y: Math.sin(a) * reach * 0.85 }
  }
  const PUPIL = lit(radialDef('alien-pupil', { x: CX, y: CY - 10 }, 8, [[0, '#4a3550'], [1, SKIN.pupil]]))
  // A pupil and the glint on it move together.
  const pupils = (off: Point, opacity: string, anim = ''): string =>
    eyes
      .map(
        e =>
          `<circle cx="${n1(e.x + off.x)}" cy="${n1(e.y + off.y)}" r="2.3" fill="${PUPIL}" opacity="${opacity}">${anim}</circle>` +
          `<circle cx="${n1(e.x + off.x - 0.8)}" cy="${n1(e.y + off.y - 0.9)}" r=".8" fill="#ffffff" opacity="${opacity === '0' ? '0' : '.95'}">${anim}</circle>`,
      )
      .join('')
  type Brow = [number, number, number, number]
  const brows = (left: Brow, right: Brow, opacity: string, anim = ''): string =>
    [left, right]
      .map(([x1, y1, x2, y2]) => `<line x1="${n1(CX + x1)}" y1="${n1(CY + y1)}" x2="${n1(CX + x2)}" y2="${n1(CY + y2)}" stroke="${SKIN.brow}" stroke-width="1.5" stroke-linecap="round" opacity="${opacity}">${anim}</line>`)
      .join('')
  const mouth = (d: string, opacity: string, anim = ''): string =>
    `<path d="${d}" fill="none" stroke="${SKIN.mouth}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}">${anim}</path>`
  const SMILE = `M${CX - 4.5} ${CY - 1.5}Q${CX} ${CY + 2.5} ${CX + 4.5} ${CY - 1.5}`
  const GRIN = `M${CX - 6} ${CY - 2.5}Q${CX} ${CY + 4.5} ${CX + 6} ${CY - 2.5}`
  const HMM = `M${CX - 3} ${CY}Q${CX + 0.5} ${CY - 1} ${CX + 4} ${CY - 1.6}`
  const WAVY = `M${CX - 5} ${CY}Q${CX - 2.5} ${CY - 2} ${CX} ${CY}Q${CX + 2.5} ${CY + 2} ${CX + 5} ${CY}`
  const FLAT: [Brow, Brow] = [[-10, -17, -3, -17], [3, -17, 10, -17]]
  const UP_BROW: Brow = [3, -19.5, 10, -18]
  const WORRY: [Brow, Brow] = [[-10, -16.5, -3, -19], [3, -19, 10, -16.5]]
  const LIFT: [Brow, Brow] = [[-10, -19, -3, -19.5], [3, -19.5, 10, -19]]

  // How long the passing mood holds, and so when the resting face takes over.
  const passing = mood.isAsking ? Infinity : Math.max(mood.startledFor, mood.cheerFor, 0)
  const isFrightened = mood.isAsking || mood.startledFor > 0
  const napAt = mood.isWorried ? Infinity : mood.napAt

  let out = ''
  // Antennae with glowing tips, then the head: always there, awake or asleep.
  for (const side of [-1, 1]) {
    const tip = { x: CX + side * 9, y: CY - 25 }
    out += `<line x1="${n1(CX + side * 4)}" y1="${n1(CY - 18)}" x2="${n1(tip.x)}" y2="${n1(tip.y)}" stroke="${SKIN.shade}" stroke-width="1.8" stroke-linecap="round"/>`
    if (!isStill) {
      const halo = boxRadial([[0, SKIN.tip, 0.8], [1, SKIN.tip, 0]])
      const pulse = `begin="${clock(-((now + (side + 1) * 350) % 1800))}" dur="1.8s" repeatCount="indefinite"`
      out += `<circle cx="${n1(tip.x)}" cy="${n1(tip.y)}" r="5.5" fill="${halo}" opacity=".5"><animate attributeName="opacity" values=".8;.15;.8" ${pulse}/></circle>`
    }
    out += `<circle cx="${n1(tip.x)}" cy="${n1(tip.y)}" r="2.8" fill="${boxRadial([[0, '#fff3e6'], [0.45, SKIN.tip], [1, '#b44e2c']], [0.5, 0.5], 0.5, [0.34, 0.32])}"/>`
  }
  out += `<ellipse cx="${CX}" cy="${CY + 4}" rx="11" ry="8" fill="${lit(radialDef('alien-body', { x: CX - 3, y: CY }, 13, [[0, SKIN.main], [1, '#6e2f1c']]))}"/>`
  out += `<ellipse cx="${head.x}" cy="${head.y}" rx="16" ry="13.5" fill="${HEAD}"/>`
  // A soft shine on the crown and a blush on each cheek.
  out += `<ellipse cx="${head.x - 5}" cy="${head.y - 6.5}" rx="7" ry="4" fill="${lit(radialDef('alien-shine', { x: head.x - 5, y: head.y - 7 }, 7, [[0, '#ffffff', 0.55], [1, '#ffffff', 0]]))}"/>`
  for (const side of [-1, 1]) {
    const cheek = { x: CX + side * 11, y: CY - 3 }
    out += `<ellipse cx="${n1(cheek.x)}" cy="${n1(cheek.y)}" rx="3.6" ry="2.4" fill="${boxRadial([[0, '#ff8f7a', 0.55], [1, '#ff8f7a', 0]])}"/>`
  }

  // Awake: the eyes, and where they go.
  let awake = eyes
    .map(e => `<ellipse cx="${n1(e.x)}" cy="${n1(e.y)}" rx="4.4" ry="5.2" fill="${boxRadial([[0, '#ffffff'], [0.7, SKIN.eye], [1, '#c9b4a6']], [0.5, 0.5], 0.6, [0.34, 0.33])}"/>`)
    .join('')
  const lookAbout = !isStill && mood.focus === undefined && passing <= 0 && !mood.isWorried
  if (mood.focus !== undefined) {
    awake += pupils(toward(mood.focus, 1.9), '1')
  } else if (mood.isWorried && !isStill) {
    const dart = `begin="${clock(-(now % 1500))}" dur="1.5s" repeatCount="indefinite"`
    awake += pupils({ x: -1.6, y: 0.4 }, '0', `<animate attributeName="opacity" values="1;1;0;0;1" keyTimes="0;.45;.5;.95;1" ${dart}/>`)
    awake += pupils({ x: 1.6, y: 0.4 }, '0', `<animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;.45;.5;.95;1" ${dart}/>`)
  } else if (lookAbout) {
    // One round: ahead, a long thoughtful look at one planet, ahead, a look at another, ahead.
    const round = Math.floor(now / LOOK_MS)
    const pick = seeded(round * 7919 + 17)
    const a = targets[Math.floor(pick() * targets.length)] ?? { x: CX + 1, y: CY }
    const b = targets[Math.floor(pick() * targets.length)] ?? { x: CX - 1, y: CY }
    const look = `begin="${clock(-(now % LOOK_MS))}" dur="${clock(LOOK_MS)}" repeatCount="indefinite"`
    const KT = '0;.18;.2;.38;.4;.6;.62;.74;.76;1'
    awake += pupils({ x: 0, y: 0 }, '1', `<animate attributeName="opacity" values="1;1;0;0;1;1;0;0;1;1" keyTimes="${KT}" ${look}/>`)
    awake += pupils(toward(a, 1.9), '0', `<animate attributeName="opacity" values="0;0;1;1;0;0;0;0;0;0" keyTimes="${KT}" ${look}/>`)
    awake += pupils(toward(b, 1.9), '0', `<animate attributeName="opacity" values="0;0;0;0;0;0;1;1;0;0" keyTimes="${KT}" ${look}/>`)
    // While it looks, it wonders: one brow up, a sideways mouth and a few thought dots.
    const on = `values="0;0;1;1;0;0;1;1;0;0" keyTimes="${KT}" ${look}`
    const off = `values="1;1;0;0;1;1;0;0;1;1" keyTimes="${KT}" ${look}`
    awake += brows(FLAT[0], FLAT[1], '1', `<animate attributeName="opacity" ${off}/>`)
    awake += brows(FLAT[0], UP_BROW, '0', `<animate attributeName="opacity" ${on}/>`)
    awake += mouth(SMILE, '1', `<animate attributeName="opacity" ${off}/>`)
    awake += mouth(HMM, '0', `<animate attributeName="opacity" ${on}/>`)
    ;[[CX + 19, CY - 19, 1.5], [CX + 24, CY - 25, 2.1], [CX + 30, CY - 32, 2.8]].forEach(([dx, dy, r], k) => {
      awake += `<circle cx="${dx}" cy="${dy}" r="${r}" fill="${c0.bone}" opacity="0"><animate attributeName="opacity" values="0;0;${k === 0 ? 1 : 0};1;0;0;${k === 0 ? 1 : 0};1;0;0" keyTimes="${KT}" ${look}/></circle>`
    })
  } else {
    awake += pupils({ x: 0, y: 0 }, '1')
  }
  // Blinks: the lids close for a moment every few seconds.
  if (!isStill) {
    const blink = `begin="${clock(-(now % 4300))}" dur="4.3s" repeatCount="indefinite"`
    awake += eyes.map(e => `<ellipse cx="${n1(e.x)}" cy="${n1(e.y)}" rx="4.8" ry="5.6" fill="${HEAD}" opacity="0"><animate attributeName="opacity" values="0;0;1;0" keyTimes="0;.95;.975;1" ${blink}/></ellipse>`).join('')
  }
  if (mood.isWorried) {
    // Heavy lids over the top of each eye.
    awake += eyes.map(e => `<path d="M${n1(e.x - 4.6)} ${n1(e.y - 1.6)}Q${n1(e.x)} ${n1(e.y - 7.2)} ${n1(e.x + 4.6)} ${n1(e.y - 1.6)}Z" fill="${HEAD}"/>`).join('')
  }
  out += windowed(awake, 0, napAt)

  // The passing mood: a fright or a question, else a cheer.
  if (isFrightened) {
    const until = mood.isAsking ? napAt : Math.min(mood.startledFor, napAt)
    out += windowed(brows(LIFT[0], LIFT[1], '1') + `<ellipse cx="${CX}" cy="${CY - 0.5}" rx="2.4" ry="2.9" fill="none" stroke="${SKIN.mouth}" stroke-width="1.5"/>`, 0, until)
  } else if (mood.cheerFor > 0) {
    out += windowed(brows(LIFT[0], LIFT[1], '1') + mouth(GRIN, '1'), 0, Math.min(mood.cheerFor, napAt))
  }

  // The resting face, once the passing mood is over: worried, or calm. Looking about has drawn its own.
  let rest = ''
  if (mood.isWorried) {
    rest += brows(WORRY[0], WORRY[1], '1') + mouth(WAVY, '1')
    // A drop of sweat that runs down and comes again.
    rest += isStill
      ? `<path transform="translate(${CX + 15} ${CY - 15})" d="M0 -3Q2.4 0.6 0 2.6Q-2.4 0.6 0 -3Z" fill="#8fd3ff" opacity=".9"/>`
      : `<path d="M0 -3Q2.4 0.6 0 2.6Q-2.4 0.6 0 -3Z" fill="#8fd3ff" opacity="0">` +
        `<animateMotion path="M${CX + 15} ${CY - 16}L${CX + 15} ${CY - 6}" begin="${clock(passing > 0 ? passing : -(now % 1600))}" dur="1.6s" repeatCount="indefinite"/>` +
        `<animate attributeName="opacity" values="0;.95;.95;0" keyTimes="0;.15;.75;1" begin="${clock(passing > 0 ? passing : -(now % 1600))}" dur="1.6s" repeatCount="indefinite"/></path>`
  } else if (!lookAbout) {
    rest += brows(FLAT[0], FLAT[1], '1') + mouth(SMILE, '1')
  }
  out += windowed(rest, passing, napAt)

  // Asleep: eyes shut, a calm mouth and a few z's drifting up.
  if (napAt !== Infinity) {
    let asleep = eyes.map(e => `<path d="M${n1(e.x - 3.6)} ${n1(e.y)}Q${n1(e.x)} ${n1(e.y + 2.6)} ${n1(e.x + 3.6)} ${n1(e.y)}" fill="none" stroke="${SKIN.brow}" stroke-width="1.4" stroke-linecap="round"/>`).join('')
    asleep += mouth(`M${CX - 2.5} ${CY - 0.5}Q${CX} ${CY + 1} ${CX + 2.5} ${CY - 0.5}`, '1')
    const zs: [number, number, number][] = [[CX + 19, CY - 22, 9], [CX + 25, CY - 31, 11], [CX + 32, CY - 41, 13]]
    zs.forEach(([zx, zy, size], k) => {
      const pulseAt = napAt > 0 ? napAt + k * 700 : -((now + k * 700) % 2800)
      const anim = isStill ? '' : `<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;.2;.7;1" begin="${clock(pulseAt)}" dur="2.8s" repeatCount="indefinite"/>`
      asleep += `<text x="${zx}" y="${zy}" ${FONT} font-size="${size}" fill="${c0.bone}" opacity="${isStill ? '.8' : '0'}">${anim}z</text>`
    })
    out += windowed(asleep, napAt, Infinity)
  }
  return out
}

/** Set by drawMap for the pilot's words: the palette of the drawing being made. */
let c0: Palette = DARK

/** The UFO: glass, the pilot inside, the saucer over the pilot's middle, and lights round the rim. All of it lit. */
function ship(mood: Mood, now: number, isStill: boolean, isBusy: boolean, core: string, targets: Point[], c: Palette): string {
  const dome = { x: CX, y: CY + 6 }
  // The dome is the part of a ball of glass above the deck, as an outline of points: the ship keeps to M, L, Q and Z.
  const cap: Point[] = []
  const base = Math.asin((DECK.y - dome.y) / 30)
  for (let k = 0; k <= 32; k++) {
    const a = Math.PI - base + ((Math.PI + 2 * base) * k) / 32
    cap.push({ x: dome.x + 30 * Math.cos(a), y: dome.y + 30 * Math.sin(a) })
  }
  const glass = poly(cap)
  let out = ''
  // A soft glow under the saucer, from its engines.
  out += `<ellipse cx="${CX}" cy="${CY + 27}" rx="40" ry="9" fill="${lit(radialDef('ufo-engine', { x: CX, y: CY + 27 }, 40, [[0, '#7fe0d3', isBusy ? 0.55 : 0.35], [1, '#7fe0d3', 0]]))}"/>`
  // The glass behind the pilot: deep at the middle, lighter towards its edge.
  out += `<path d="${glass}" fill="${lit(radialDef('ufo-glass-back', dome, 30, [[0, '#0d1830'], [0.75, '#16274a'], [1, '#2a4473']]))}"/>`
  out += pilot(mood, now, isStill, targets)
  // The glass in front: clear in the middle, catching light at its edge, with a long glint and a small one.
  out += `<path d="${glass}" fill="${lit(radialDef('ufo-glass', dome, 30, [[0, '#bfe3ff', 0], [0.7, '#bfe3ff', 0.05], [0.9, '#d6eeff', 0.24], [1, '#eef8ff', 0.5]]))}"/>`
  out += `<path d="${poly(cap, false)}" fill="none" stroke="#d6eeff" stroke-width=".9" opacity=".5"/>`
  out += `<path d="M${CX - 23} ${CY - 4}Q${CX - 19} ${CY - 18} ${CX - 7} ${CY - 22.5}" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" opacity=".55"/>`
  out += `<circle cx="${CX + 15}" cy="${CY - 15}" r="1.6" fill="#ffffff" opacity=".6"/>`
  // The saucer: a dark hull underneath, a brushed metal deck with its light top, and a band round the edge.
  out += `<ellipse cx="${CX}" cy="${CY + 19}" rx="34" ry="7.5" fill="${lit(linearDef('ufo-hull', { x: CX, y: CY + 12 }, { x: CX, y: CY + 27 }, [[0, '#8a93a8'], [0.5, '#4a5266'], [1, '#22273a']]))}"/>`
  out += `<ellipse cx="${DECK.x}" cy="${DECK.y}" rx="${DECK.rx}" ry="${DECK.ry}" fill="${lit(
    linearDef('ufo-deck', { x: CX - DECK.rx, y: DECK.y }, { x: CX + DECK.rx, y: DECK.y }, [
      [0, '#4d566a'],
      [0.14, '#aeb7c9'],
      [0.3, '#7d879c'],
      [0.46, '#eef1f7'],
      [0.6, '#a2acc0'],
      [0.8, '#d3d9e5'],
      [1, '#4d566a'],
    ]),
  )}"/>`
  out += `<ellipse cx="${DECK.x}" cy="${DECK.y}" rx="${DECK.rx}" ry="${DECK.ry}" fill="${lit(linearDef('ufo-deck-shade', { x: CX, y: DECK.y - DECK.ry }, { x: CX, y: DECK.y + DECK.ry }, [[0, '#ffffff', 0.3], [0.45, '#ffffff', 0], [1, '#000000', 0.45]]))}"/>`
  out += `<ellipse cx="${DECK.x}" cy="${DECK.y - 2.5}" rx="${DECK.rx - 8}" ry="${DECK.ry - 4}" fill="${lit(linearDef('ufo-top', { x: CX - DECK.rx + 8, y: DECK.y - 6 }, { x: CX + DECK.rx - 8, y: DECK.y + 1 }, [[0, '#9aa4b8'], [0.35, '#f4f6fb'], [0.7, '#c5ccda'], [1, '#7d879c']]))}"/>`
  out += `<ellipse cx="${DECK.x}" cy="${DECK.y}" rx="${DECK.rx}" ry="${DECK.ry}" fill="none" stroke="#3b4254" stroke-width="1"/>`
  out += `<path d="M${CX - 46} ${DECK.y + 4.5}Q${CX} ${DECK.y + 11} ${CX + 46} ${DECK.y + 4.5}" fill="none" stroke="#ffffff" stroke-width=".8" stroke-linecap="round" opacity=".35"/>`
  // Its name along the front of the deck.
  out += `<text x="${CX}" y="${CY + 16.5}" text-anchor="middle" ${FONT} font-size="6.5" letter-spacing="1.2" fill="#3b4254">${escapeXml(core)}</text>`
  // Lights round the rim, each a glowing bead with a halo: they chase while work runs and glow softly at rest.
  const LIGHTS = 9
  const lap = isBusy ? 1200 : 3600
  for (let k = 0; k < LIGHTS; k++) {
    const a = Math.PI * 0.08 + (Math.PI * 0.84 * k) / (LIGHTS - 1)
    const at = { x: DECK.x - DECK.rx * 0.9 * Math.cos(a), y: DECK.y + DECK.ry * 0.62 * Math.sin(a) + 1 }
    const hue = k % 3 === 0 ? SKIN.main : k % 3 === 1 ? '#ffd166' : '#7fe0d3'
    const halo = `fill="${boxRadial([[0, hue, 0.7], [1, hue, 0]])}"`
    const bead = `fill="${boxRadial([[0, '#ffffff'], [0.45, hue], [1, tint(hue, -0.35)]], [0.5, 0.5], 0.5, [0.37, 0.34])}"`
    const where = `cx="${n1(at.x)}" cy="${n1(at.y)}"`
    if (isStill) {
      out += `<circle ${where} r="4.2" ${halo} opacity=".5"/><circle ${where} r="1.9" ${bead}/>`
    } else {
      const chase = `begin="${clock(-((now + (k * lap) / LIGHTS) % lap))}" dur="${clock(lap)}" repeatCount="indefinite"`
      out +=
        `<circle ${where} r="4.2" ${halo} opacity=".2"><animate attributeName="opacity" values="1;.1;.1;1" keyTimes="0;.3;.85;1" ${chase}/></circle>` +
        `<circle ${where} r="1.9" ${bead} opacity=".5"><animate attributeName="opacity" values="1;.45;.45;1" keyTimes="0;.3;.85;1" ${chase}/></circle>`
    }
  }
  // The pilot's bubble: ? while it waits on you, ! for a while after something went wrong.
  const bubble = (sign: string, color: string): string =>
    `<circle cx="${CX + 27}" cy="${CY - 28}" r="8.5" fill="${c.raised}" stroke="${color}" stroke-width="1.2"/>` +
    `<text x="${CX + 27}" y="${CY - 24}" text-anchor="middle" ${FONT} font-size="13" fill="${color}">${sign}</text>`
  if (mood.isAsking) out += bubble('?', '#ffd166')
  else if (mood.startledFor > 0) out += windowed(bubble('!', c.red), 0, mood.startledFor)
  // An answer gets a little shower of sparkles.
  if (mood.cheerFor > 0 && !mood.isAsking && mood.startledFor <= 0 && !isStill) {
    const spots: [number, number][] = [[-34, -26], [36, -18], [-40, 2], [30, -36], [-20, -40], [44, 4]]
    let sparkles = ''
    spots.forEach(([dx, dy], k) => {
      const s = 3.4
      const twinkle = `begin="${clock(-((now + k * 230) % 1400))}" dur="1.4s" repeatCount="indefinite"`
      sparkles += `<path d="M${n1(CX + dx)} ${n1(CY + dy - s)}L${n1(CX + dx)} ${n1(CY + dy + s)}M${n1(CX + dx - s)} ${n1(CY + dy)}L${n1(CX + dx + s)} ${n1(CY + dy)}" fill="none" stroke="#ffd166" stroke-width="1.4" stroke-linecap="round" opacity="0"><animate attributeName="opacity" values="0;1;0" ${twinkle}/></path>`
    })
    out += windowed(sparkles, 0, mood.cheerFor)
  }
  return out
}

/**
 * The ship drawn at its own size, made SHIP times bigger about the centre: every place, length and outline. The ship
 * uses absolute M, L, Q and Z outlines only, so its numbers come in pairs.
 */
function enlarged(svg: string): string {
  const k = SHIP
  const px = (v: string): string => n1(CX + (Number(v) - CX) * k)
  const py = (v: string): string => n1(CY + (Number(v) - CY) * k)
  const pairs = (d: string): string => {
    let isX = true
    return d.replace(/-?\d+(\.\d+)?/g, v => {
      const out = isX ? px(v) : py(v)
      isX = !isX
      return out
    })
  }
  return svg
    .replace(/ (cx|fx|x|x1|x2)="(-?[\d.]+)"/g, (_, a: string, v: string) => ` ${a}="${px(v)}"`)
    .replace(/ (cy|fy|y|y1|y2)="(-?[\d.]+)"/g, (_, a: string, v: string) => ` ${a}="${py(v)}"`)
    .replace(/ (r|rx|ry|stroke-width|font-size|letter-spacing)="(-?[\d.]+)"/g, (_, a: string, v: string) => ` ${a}="${n1(Number(v) * k)}"`)
    .replace(/ (d|path)="([^"]*)"/g, (_, a: string, d: string) => ` ${a}="${pairs(d)}"`)
    .replace(/attributeName="r" values="([^"]*)"/g, (_, v: string) => `attributeName="r" values="${v.split(';').map(x => n1(Number(x) * k)).join(';')}"`)
    .replace(/transform="translate\((-?[\d.]+) (-?[\d.]+)\)"/g, (_, x: string, y: string) => `transform="translate(${px(x)} ${py(y)})"`)
}

// ---- the whole map ------------------------------------------------------------------------------

/**
 * The map as one SVG. `forPicture` is for the terminal's painted picture: the sky behind is drawn plain there, since
 * a sky of soft gradients the size of the whole picture packs into a PNG several times larger.
 */
export function drawMap(board: Board, now: number, setup: Setup, forPicture = false): string {
  // Space is dark whatever the theme; a person's own colors still take the places they name.
  const c: Palette = { ...DARK, ...setup.colors }
  c0 = c
  DEFS = []
  SHARED = []
  DEFINED = new Set()
  const shift = setup.layout === 'you-bottom' ? STATIONS.length / 2 : 0
  const recent = board.entries.slice(-40)
  const isStill = setup.motion === 'reduced'
  const flights = isStill ? [] : recent.filter(e => now - e.startedAt < ROCKET_MS).slice(-14)
  const returns = isStill ? [] : recent.filter(e => e.endedAt !== undefined && e.from !== 'inbound' && now - e.endedAt < ROCKET_MS).slice(-14)
  const beams = recent.filter(e => now - e.startedAt < GLOW_MS / 2).slice(-10)
  const running = recent.filter(e => e.status === 'run')
  const anyRunning = running.length > 0
  const agentsAt = place(indexOf('agents'), shift)
  const isBad = (e: Entry): boolean => e.status === 'block' || e.status === 'err'
  const targets = STATIONS.map((_, i) => place(i, shift))

  let body = ''
  const isOwnGround = c.ground !== DARK.ground
  body += once(`sky:${setup.background}:${forPicture}:${isOwnGround ? c.ground : ''}`, () => {
    let sky = ''
    if (setup.background !== 'transparent') {
      sky += `<rect width="${W}" height="${H}" rx="12" fill="${isOwnGround ? c.ground : SPACE}"/>`
      // Deep space: a little lighter in the middle, and clouds of gas far behind everything. A ground of the person's own is left plain.
      const nebula: [number, number, number, string, number][] = [
        [96, 88, 120, '#5b3fb0', 0.32],
        [392, 352, 140, '#1f6c8f', 0.3],
        [410, 70, 80, '#a0407a', 0.16],
      ]
      if (!isOwnGround && forPicture) {
        nebula.forEach(([x, y, r, color, a]) => {
          sky += `<circle cx="${x}" cy="${y}" r="${n1(r * 0.7)}" fill="${color}" opacity="${n1(a * 0.45)}"/>`
        })
      } else if (!isOwnGround) {
        sky += `<rect width="${W}" height="${H}" rx="12" fill="${boxRadial([[0, '#15204a', 0.85], [0.55, '#0b1230', 0.4], [1, SPACE, 0]], [0.5, 0.49], 0.72)}"/>`
        nebula.forEach(([x, y, r, color, a]) => {
          sky += `<circle cx="${x}" cy="${y}" r="${r}" fill="${boxRadial([[0, color, a], [0.5, color, a * 0.45], [1, color, 0]])}"/>`
        })
      }
    }
    // Stars that keep still, the same every drawing; now and then a nearer one with a glow round it.
    const rnd = seeded(20261115)
    for (let k = 0; k < 80; k++) {
      const sx = rnd() * W
      const sy = rnd() * H
      const r = 0.35 + rnd() * 0.9
      const o = 0.25 + rnd() * 0.6
      if (k % 7 === 0) continue
      if (k % 9 === 4) {
        if (!forPicture) sky += `<circle cx="${n1(sx)}" cy="${n1(sy)}" r="5" fill="${boxRadial([[0, '#cfe2ff', 0.6], [1, '#cfe2ff', 0]])}"/>`
        sky += `<circle cx="${n1(sx)}" cy="${n1(sy)}" r="${n1(r + 0.4)}" fill="#ffffff"/>`
      } else sky += `<circle cx="${n1(sx)}" cy="${n1(sy)}" r="${n1(r)}" fill="#ffffff" opacity="${n1(o)}"/>`
    }
    return sky
  })
  // The stars that twinkle, all together after the still ones.
  const rnd = seeded(20261115)
  for (let k = 0; k < 80; k++) {
    const sx = rnd() * W
    const sy = rnd() * H
    const r = 0.35 + rnd() * 0.9
    const o = 0.25 + rnd() * 0.6
    if (k % 7 !== 0) continue
    if (isStill) {
      body += `<circle cx="${n1(sx)}" cy="${n1(sy)}" r="${n1(r + 0.25)}" fill="#ffffff" opacity="${n1(o)}"/>`
      continue
    }
    const dur = 2200 + ((k * 7919) % 3000)
    body += `<circle cx="${n1(sx)}" cy="${n1(sy)}" r="${n1(r + 0.25)}" fill="#ffffff" opacity="${n1(o)}"><animate attributeName="opacity" values="${n1(o)};.08;${n1(o)}" begin="${clock(-(now % dur))}" dur="${clock(dur)}" repeatCount="indefinite"/></circle>`
  }

  // Lanes from the ship to each planet, worn in with use: by the end of a session the map shows where the work went.
  STATIONS.forEach((s, i) => {
    const p = place(i, shift)
    const a = rim(p)
    const b = edge(p, a, NODE + 3)
    const worn = Math.min(1, Math.log2(1 + (board.counts[s.id] ?? 0)) / 7)
    const line = `x1="${n1(a.x)}" y1="${n1(a.y)}" x2="${n1(b.x)}" y2="${n1(b.y)}" stroke-linecap="round"`
    body += `<line ${line} stroke="${c.spoke === DARK.spoke ? '#1d2643' : c.spoke}" stroke-width="1" stroke-dasharray="2 5"/>`
    if (worn > 0) body += `<line ${line} stroke="${LOOKS[s.id].accent}" stroke-width="${n1(0.8 + 2.2 * worn)}" opacity="${n1(0.12 + worn * 0.4)}"/>`
  })

  const scene: Scene = { entries: recent, board, now, c, names: setup.t.stations, isStill, shift }
  const drawn = STATIONS.map((s, i) => station(s, i, scene))
  body += drawn.map(d => d.under).join('')
  body += trail(recent, now, c, isStill, shift)

  /** Where an entry's trip starts (the ship, or the agents planet for a subagent's call) and where it docks. */
  const ends = (e: Entry): [Point, Point] => {
    const p = place(indexOf(e.station), shift)
    const start = e.from === 'agents' ? agentsAt : rim(p)
    const a = e.from === 'agents' ? edge(agentsAt, p, NODE + 6) : start
    return [a, edge(p, start, NODE + 8)]
  }
  const lane = (list: Entry[], e: Entry): number => {
    const peers = list.filter(x => x.station === e.station && x.from === e.from)
    return (peers.indexOf(e) - (peers.length - 1) / 2) * 9
  }

  for (const e of beams) {
    const [a, b] = ends(e)
    const color = isBad(e) ? c.red : LOOKS[e.station].accent
    body +=
      `<line x1="${n1(a.x)}" y1="${n1(a.y)}" x2="${n1(b.x)}" y2="${n1(b.y)}" stroke="${color}" stroke-width="1.2"${e.from === 'inbound' ? ' stroke-dasharray="3 4"' : ''} opacity="0">` +
      `<animate attributeName="opacity" values=".55;0" begin="${clock(-(now - e.startedAt))}" dur="${clock(GLOW_MS / 2)}" fill="freeze"/></line>`
  }

  body += drawn.map(d => d.body).join('')

  // Rockets parked at planets whose call still runs, once their outward trip is over.
  const parkedAt = new Set<StationId>()
  for (const e of running) {
    if (e.from === 'inbound' || parkedAt.has(e.station)) continue
    if (!isStill && now - e.startedAt < ROCKET_MS) continue
    parkedAt.add(e.station)
    const p = place(indexOf(e.station), shift)
    body += docked(p, e.from === 'agents' ? agentsAt : { x: SAUCER.x, y: SAUCER.y }, LOOKS[e.station].accent)
  }
  for (const e of flights) {
    const [a, b] = aside(...ends(e), lane(flights, e))
    const age = now - e.startedAt
    if (e.from === 'inbound') body += spark(b, a, LOOKS[e.station].accent, age)
    else body += rocket(a, b, LOOKS[e.station].accent, age, e.status === 'block')
  }
  for (const e of returns) {
    const [a, b] = aside(...ends(e), lane(returns, e))
    body += rocket(b, a, LOOKS[e.station].accent, now - (e.endedAt as number), e.status !== 'ok')
  }

  body += drawn.map(d => d.over).join('')

  // Each subagent still at work is a small moon circling the agents planet.
  const crew = (board.agents ?? []).slice(0, 6)
  crew.forEach((_, k) => {
    const lap = 7000
    const spin = `${n1(agentsAt.x)} ${n1(agentsAt.y)}`
    const spot = { x: agentsAt.x, y: agentsAt.y - NODE - 7 }
    const moon = `<circle cx="${n1(spot.x)}" cy="${n1(spot.y)}" r="3.4" fill="${boxRadial([[0, '#ffffff'], [0.5, '#c9c3d8'], [1, '#5d5670']], [0.5, 0.5], 0.62, [0.32, 0.31])}\"/>`
    if (isStill) {
      body += `<g transform="rotate(${n1((360 * k) / crew.length)} ${spin})">${moon}</g>`
      return
    }
    body +=
      `<g><animateTransform attributeName="transform" type="rotate" from="0 ${spin}" to="360 ${spin}" begin="${clock(-((now + (k * lap) / crew.length) % lap))}" dur="${clock(lap)}" repeatCount="indefinite"/>` +
      `${moon}</g>`
  })

  // The context window as a ring around the ship: it fills as the session goes and empties at a compaction.
  if (board.context !== undefined) {
    const full = Math.max(0, Math.min(100, Math.round(board.context)))
    const ring = `cx="${CX}" cy="${CY}" r="${RING}" fill="none" stroke-width="2.4"`
    body +=
      `<circle ${ring} stroke="${c.line}" opacity=".6"/>` +
      `<circle ${ring} stroke="${full >= 90 ? c.red : full >= 70 ? '#ffd166' : '#7fe0a0'}" stroke-linecap="round" pathLength="100" stroke-dasharray="${full} 100" transform="rotate(-90 ${CX} ${CY})"/>` +
      `<text x="${CX}" y="${CY - RING - 6}" text-anchor="middle" ${FONT} font-size="9" paint-order="stroke" stroke="${SPACE}" stroke-width="3" fill="${c.dim}">${full}%</text>`
  }

  // The pilot's mood, from the board, as windows of time from now.
  const lastAt = recent.length > 0 ? Math.max(...recent.map(e => e.endedAt ?? e.startedAt)) : undefined
  const done = recent.filter(e => e.mark === 'done').pop()
  const focusOn = running.filter(e => e.from !== 'inbound').pop()
  const lastFault = recent.filter(e => isBad(e) && e.station !== 'you').map(e => e.endedAt ?? e.startedAt)
  const mood: Mood = {
    isWorried: (board.context ?? 0) >= 80,
    isAsking: running.some(e => e.station === 'you'),
    startledFor: lastFault.length > 0 ? Math.max(...lastFault) + ALARM_MS - now : 0,
    cheerFor: done !== undefined && !anyRunning ? done.startedAt + CHEER_MS - now : 0,
    napAt: !anyRunning && lastAt !== undefined ? lastAt + NAP_MS - now : Infinity,
    focus: focusOn === undefined ? undefined : place(indexOf(focusOn.station), shift),
  }
  // The ship's gradients are drawn at its own size with it, then scaled up together.
  const outside = DEFS
  DEFS = []
  const craft = ship(mood, now, isStill, anyRunning, setup.core, targets, c)
  body += enlarged(`<defs>${DEFS.join('')}</defs>${craft}`)
  DEFS = outside

  const switchAge = board.switchedAt === undefined ? Infinity : now - board.switchedAt
  const isSwitching = switchAge >= 0 && switchAge < SWITCH_MS
  if (board.model !== undefined) {
    body += `<text x="${CX}" y="${CY + 56}" text-anchor="middle" ${FONT} font-size="9.5" paint-order="stroke" stroke="${SPACE}" stroke-width="3" fill="${isSwitching ? c.hot : c.ash}">${escapeXml(shortModel(board.model))}</text>`
  }

  // A changed model rings at the ship and at Jupiter for a few seconds.
  if (isSwitching && !isStill) {
    const model = place(indexOf('model'), shift)
    const laps = Math.ceil((SWITCH_MS - switchAge) / 1600)
    for (const [p, r] of [[{ x: CX, y: CY }, 54], [model, NODE]] as const) {
      const ringing = `begin="${clock(-(switchAge % 1600))}" dur="1.6s" repeatCount="${laps}" fill="freeze"`
      body +=
        `<circle cx="${n1(p.x)}" cy="${n1(p.y)}" r="${r}" fill="none" stroke="${c.bone}" stroke-width="1.4" opacity="0">` +
        `<animate attributeName="r" values="${r};${r + 26}" ${ringing}/>` +
        `<animate attributeName="opacity" values=".7;0" ${ringing}/></circle>`
    }
  }

  // The answer leaves the ship as one wide ring.
  if (done !== undefined && now - done.startedAt < DONE_MS && !isStill) {
    const leaving = `begin="${clock(done.startedAt - now)}" dur="${clock(DONE_MS)}" fill="freeze"`
    body +=
      `<circle cx="${CX}" cy="${CY}" r="58" fill="none" stroke="${c.bone}" stroke-width="1.6" opacity="0">` +
      `<animate attributeName="r" values="58;${RING + 30}" ${leaving}/>` +
      `<animate attributeName="opacity" values=".6;0" ${leaving}/></circle>`
  }

  // Twice the viewBox, so the picture fills whatever room the pane gives it.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W * 2}" height="${H * 2}"><defs>${[...SHARED].sort().join('')}${[...DEFS].sort().join('')}</defs>${body}</svg>`
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] as string)
}
