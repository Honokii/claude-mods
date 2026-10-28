// Pixel critters: one per agent, its body and hat picked from its name, its
// colour from its model. Drawn as an SVG string; it hops and blinks while the
// agent runs.

// Body rows 4-11 of a 12x12 grid: # body, e eye, m mouth and feet (shade).
const BODIES: string[][] = [
  [
    '...######...',
    '..########..',
    '.##e####e##.',
    '.##########.',
    '.####mm####.',
    '..########..',
    '..##....##..',
    '..mm....mm..',
  ],
  [
    '....####....',
    '...######...',
    '...#e##e#...',
    '...######...',
    '...##mm##...',
    '...######...',
    '...######...',
    '...m....m...',
  ],
  [
    '............',
    '..##....##..',
    '.#e#....#e#.',
    '.##########.',
    '############',
    '#####mm#####',
    '.##########.',
    '.mm......mm.',
  ],
]

// Hat rows 0-3: h hat.
const HATS: string[][] = [
  ['............', '............', '............', '............'],
  ['............', '............', '....hhhh....', '..hhhhhhhh..'],
  ['......hh....', '.......h....', '.......h....', '............'],
  ['............', '...h.hh.h...', '...hhhhhh...', '............'],
  ['............', '...hh..hh...', '....hhhh....', '............'],
  ['.....hh.....', '....h.......', '.....h......', '............'],
]

const HAT_COLORS = ['#e4c560', '#e79ac0', '#7fb3a8', '#c98fd6', '#f2f2f2', '#e0794f']

// Opus orange, Sonnet blue, Haiku green; anything else violet.
export const modelColor = (model: string): string =>
  /opus/i.test(model) ? '#e0794f' : /sonnet/i.test(model) ? '#6c9fe0' : /haiku/i.test(model) ? '#8fcf7a' : '#b08fe0'

const hash = (s: string): number => {
  let h = 2166136261
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return h >>> 0
}

// The colour a little darker, for the mouth and feet.
const shade = (hex: string): string => {
  const n = parseInt(hex.slice(1), 16)
  const c = (v: number) => Math.round(v * 0.62).toString(16).padStart(2, '0')
  return `#${c((n >> 16) & 255)}${c((n >> 8) & 255)}${c(n & 255)}`
}

export function critterSvg(name: string, model: string, size: number, isRunning: boolean): string {
  const h = hash(name)
  const body = BODIES[h % BODIES.length] ?? BODIES[0] ?? []
  const hat = HATS[(h >>> 4) % HATS.length] ?? []
  const hatColor = HAT_COLORS[(h >>> 8) % HAT_COLORS.length] ?? '#e4c560'
  const color = modelColor(model)
  const dark = shade(color)

  const px: string[] = []
  const put = (rows: string[], top: number) =>
    rows.forEach((row, y) =>
      [...row].forEach((ch, x) => {
        const fill = ch === '#' ? color : ch === 'm' ? dark : ch === 'h' ? hatColor : ch === 'e' ? '#1a1a1a' : ''
        if (fill) px.push(`<rect${ch === 'e' ? ' class="eye"' : ''} x="${x}" y="${y + top}" width="1" height="1" fill="${fill}"/>`)
      }),
    )
  put(hat, 0)
  put(body, 4)

  // Out of phase by name, so a row of running critters does not hop in step.
  const delay = ((h >>> 12) % 6) / 10
  const style = isRunning
    ? `<style>
.bob{animation:hop .9s ${delay}s infinite}
.eye{animation:blink 3.2s ${delay}s infinite}
@keyframes hop{0%,55%,100%{transform:translateY(0)}20%,35%{transform:translateY(-1px)}}
@keyframes blink{0%,92%,100%{opacity:1}95%{opacity:0}}
@media (prefers-reduced-motion: reduce){.bob,.eye{animation:none}}
</style>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 -1 12 13" shape-rendering="crispEdges">${style}<g class="bob">${px.join('')}</g></svg>`
}
