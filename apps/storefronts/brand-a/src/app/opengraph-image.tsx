import { ImageResponse } from 'next/og';
import { brandConfig } from '@/brand/config';

/**
 * Brand A's default share card — the fallback for every page that does not render its own
 * (issue #140, "favicon/OG defaults"). The product card next to it stays product-specific.
 *
 * Drawn in the brand palette rather than the kit's neutral: Paper ground, Ink type, one Clay rule,
 * square corners, no gradient (`src/brand/DESIGN.md` §2, §4). A share card is often the first thing
 * anyone sees of a brand, so a generic dark card here would undo the theme at exactly the wrong
 * moment.
 *
 * **It does not use Newsreader or Hanken Grotesk, and cannot yet.** `ImageResponse` renders through
 * Satori, which reads TTF/OTF/WOFF and not WOFF2 — the two formats this app vendors are WOFF2 only
 * (`src/brand/fonts/`). Shipping a TTF purely for share cards would add ~150 kB to the repository to
 * serve an image nobody renders on the critical path, so the card asks for a generic serif and the
 * hierarchy is carried by size, case and spacing instead. If brand A later needs its real faces
 * here, the fix is a TTF subset beside the WOFF2, not a change to this layout.
 */
export const alt = brandConfig.name;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// The five named values, repeated as literals rather than imported from `tokens.ts`: this module
// renders in the edge/Node OG runtime, and `tokens.ts` pulls in `next/font/local`, which does not
// belong in an image route. `test/brand-theme.test.ts` asserts these match the tokens.
const PAPER = '#F7F4EF';
const INK = '#23201B';
const CLAY = '#9C4A32';
const STONE = '#6B6357';

export default function OpengraphImage(): ImageResponse {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: PAPER,
        color: INK,
        padding: 90,
        fontFamily: 'serif',
      }}
    >
      <div
        style={{
          fontSize: 26,
          letterSpacing: 6,
          textTransform: 'uppercase',
          color: STONE,
          fontFamily: 'sans-serif',
          display: 'flex',
        }}
      >
        {brandConfig.name}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {/* The one warm mark on the card, and the only non-neutral thing in the theme. */}
        <div style={{ width: 84, height: 3, background: CLAY, display: 'flex' }} />
        <div style={{ fontSize: 64, lineHeight: 1.15, marginTop: 34, display: 'flex' }}>
          {brandConfig.description}
        </div>
      </div>
    </div>,
    size,
  );
}
