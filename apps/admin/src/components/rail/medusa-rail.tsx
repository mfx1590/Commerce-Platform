'use client';

import { usePathname, useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import type { NavItem } from '@/lib/nav/navigation';
import { cn } from '@/lib/utils';
import { activeItemId } from './active';
import styles from './medusa-rail.module.css';
import { RailList } from './rail-list';
import { HEAD_ASSET, HEAD_BOX, MOTES, MOTION, RAIL_VIEWBOX, STORAGE, STROKE } from './rail.config';
import {
  REST_POSE,
  approximateLength,
  eyePoint,
  focusRing,
  headAngle,
  labelPosition,
  serpentPath,
  serpentShape,
  tonguePath,
  type Pose,
  type SerpentShape,
} from './serpent-geometry';

export type RailScope = 'store' | 'hq';

export interface MedusaRailProps {
  /** Already permission-filtered on the server (`hqNavItems`). Empty means no HQ scope at all. */
  hqItems: readonly NavItem[];
  /** Already permission-filtered for the selected store (`storeNavItems`). */
  storeItems: readonly NavItem[];
  /** Names the store scope; null when no store is selected. */
  storeName: string | null;
  userName: string;
}

const SCOPE_ORDER: readonly RailScope[] = ['store', 'hq'];

function prefers(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(query).matches;
}

function readListPreference(): boolean | null {
  try {
    const stored = window.localStorage.getItem(STORAGE.listView);
    return stored === null ? null : stored === '1';
  } catch {
    return null;
  }
}

function writeListPreference(value: boolean): void {
  try {
    window.localStorage.setItem(STORAGE.listView, value ? '1' : '0');
  } catch {
    // Private mode or blocked storage: the toggle still works for this page.
  }
}

function introAlreadySeen(): boolean {
  try {
    if (window.sessionStorage.getItem(STORAGE.introSeen) === '1') return true;
    window.sessionStorage.setItem(STORAGE.introSeen, '1');
    return false;
  } catch {
    return false;
  }
}

/** The one place a serpent's attributes are written, for the first render and for every frame. */
function poseAttributes(shape: SerpentShape, pose: Pose, label: string) {
  const d = serpentPath(shape, pose);
  const angle = headAngle(shape, pose);
  const eye = eyePoint(shape.tip, angle);
  const text = labelPosition(shape.tip);
  const ring = focusRing(shape.tip, label);
  return {
    d,
    angle,
    bodyWidth: STROKE.body + pose.lift * STROKE.liftExtra,
    outerWidth: STROKE.outer + pose.lift * STROKE.liftExtra,
    headTransform: `rotate(${angle.toFixed(1)} ${shape.tip.x} ${shape.tip.y})`,
    eye,
    tongue: tonguePath(shape.tip, angle),
    text,
    ring,
  };
}

function applyPose(group: SVGGElement, shape: SerpentShape, pose: Pose, label: string): void {
  const a = poseAttributes(shape, pose, label);
  const part = (name: string) => group.querySelector<SVGElement>(`[data-part="${name}"]`);
  part('outer')?.setAttribute('d', a.d);
  part('outer')?.setAttribute('stroke-width', a.outerWidth.toFixed(2));
  part('body')?.setAttribute('d', a.d);
  part('body')?.setAttribute('stroke-width', a.bodyWidth.toFixed(2));
  part('scales')?.setAttribute('d', a.d);
  part('head')?.setAttribute('transform', a.headTransform);
  part('eye')?.setAttribute('cx', a.eye.x.toFixed(1));
  part('eye')?.setAttribute('cy', a.eye.y.toFixed(1));
  part('tongue')?.setAttribute('d', a.tongue);
}

/**
 * The Medusa rail: the head artwork with one procedural serpent per section the principal may see.
 *
 * What arrives here is already the permission-filtered list from `GET /admin/me` — a section the
 * user lacks never grows a serpent, which is the whole point of the design: the rail is the
 * permission model made visible. Nothing here fetches, and nothing here decides access.
 *
 * Motion (the brief's spec): a load sequence once per session, a slow breathing head, an
 * independent sway per serpent, a lift toward the pointer on hover/focus with a pulsing gold eye,
 * a gaze that leans toward the pointer. All of it is driven from `serpent-geometry.ts` in one
 * `requestAnimationFrame` loop that writes attributes directly (React is not re-rendered per
 * frame) and pauses when the tab is hidden. Under `prefers-reduced-motion` nothing moves and the
 * plain list takes over; the same list is what touch devices get by default and what anyone can
 * choose with the toggle (persisted per browser).
 */
export function MedusaRail({ hqItems, storeItems, storeName, userName }: MedusaRailProps) {
  const pathname = usePathname();
  const router = useRouter();

  const scopes = useMemo(
    () => ({
      store: {
        label: storeName ?? 'Store',
        items: storeItems,
        small: `${storeName ?? 'Store'} · Admin`,
      },
      hq: { label: 'HQ', items: hqItems, small: 'HQ · Admin' },
    }),
    [hqItems, storeItems, storeName],
  );
  const available = SCOPE_ORDER.filter((scope) => scopes[scope].items.length > 0);

  // The scope follows the URL: an HQ path shows the HQ serpents. A store admin with no HQ items
  // only ever sees the store scope, and vice versa.
  const scopeFromPath: RailScope =
    activeItemId(pathname, hqItems) !== null && available.includes('hq')
      ? 'hq'
      : available.includes('store')
        ? 'store'
        : 'hq';
  // The switch is an override that lasts until the next navigation, so it needs no effect: it is
  // derived from state that remembers which path it was chosen on.
  const [override, setOverride] = useState<{ path: string; scope: RailScope } | null>(null);
  const scope = override !== null && override.path === pathname ? override.scope : scopeFromPath;
  const setScope = (next: RailScope) => setOverride({ path: pathname, scope: next });

  const items = scopes[scope].items;
  const activeId = activeItemId(pathname, items);
  const shapes = useMemo(() => items.map((_, index) => serpentShape(index, items.length)), [items]);

  // ---- list view / reduced motion (decided on the client, after mount) ----
  // The server cannot know the device, so the first render is the serpent view and the decision is
  // taken once, on mount. Nothing motion-related may start before `decided` — otherwise a
  // reduced-motion device would see one frame requested and the session's intro flag consumed.
  const [decided, setDecided] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [listView, setListView] = useState(false);
  useEffect(() => {
    const reducedMotion = prefers('(prefers-reduced-motion: reduce)');
    const touch = prefers('(hover: none)');
    setReduced(reducedMotion);
    setListView(reducedMotion || (readListPreference() ?? touch));
    setDecided(true);
  }, []);
  const showList = listView || reduced;

  const toggleList = (checked: boolean) => {
    setListView(checked);
    writeListPreference(checked);
  };

  // ---- navigation ----
  const navigate = useCallback((href: string) => router.push(href), [router]);
  const onKeyDown = (href: string) => (event: KeyboardEvent<SVGGElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      navigate(href);
    }
  };

  // ---- animation state, kept in refs so frames never re-render React ----
  const railRef = useRef<HTMLElement>(null);
  const headRef = useRef<SVGGElement>(null);
  const groupRefs = useRef<(SVGGElement | null)[]>([]);
  const liftRef = useRef<number[]>([]);
  const hoverRef = useRef<number | null>(null);
  const gazeRef = useRef(0);
  /**
   * The load sequence as a state machine, exposed as `data-intro` so a test (or a screenshot) can
   * wait for `done`: 'pending' until the device is known and the effect has run — a plain boolean
   * would read as "finished" for the one render before the sequence starts.
   */
  const [intro, setIntro] = useState<'pending' | 'playing' | 'done'>('pending');
  const introducing = intro === 'playing';
  const breathing = intro === 'done' && decided && !showList && !reduced;

  const animating = decided && !showList && !reduced;

  useEffect(() => {
    if (!animating) return;
    let frame = 0;
    let running = true;
    const tick = (time: number) => {
      if (!running) return;
      shapes.forEach((shape, index) => {
        const group = groupRefs.current[index];
        const item = items[index];
        if (group === null || group === undefined || item === undefined) return;
        const target = hoverRef.current === index || item.id === activeId ? 1 : 0;
        const current = liftRef.current[index] ?? target;
        const lift = current + (target - current) * MOTION.liftEase;
        liftRef.current[index] = lift;
        applyPose(
          group,
          shape,
          { timeMs: time, lift, gaze: gazeRef.current, motion: true },
          item.label,
        );
      });
      frame = window.requestAnimationFrame(tick);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        running = false;
        window.cancelAnimationFrame(frame);
      } else if (!running) {
        running = true;
        frame = window.requestAnimationFrame(tick);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    frame = window.requestAnimationFrame(tick);
    return () => {
      running = false;
      window.cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [animating, shapes, items, activeId]);

  // ---- load sequence: once per session, skipped entirely without motion ----
  useEffect(() => {
    if (!decided) return;
    if (!animating || introAlreadySeen()) {
      setIntro('done');
      return;
    }
    shapes.forEach((shape, index) => {
      const group = groupRefs.current[index];
      if (group === null || group === undefined) return;
      const length = Math.ceil(approximateLength(shape, REST_POSE)) + 2;
      group.style.setProperty('--len', String(length));
      group.style.setProperty(
        '--delay',
        `${((MOTION.introHeadMs + index * MOTION.introStaggerMs) / 1000).toFixed(2)}s`,
      );
    });
    setIntro('playing');
    const total = MOTION.introHeadMs + shapes.length * MOTION.introStaggerMs + MOTION.introTailMs;
    const timer = window.setTimeout(() => setIntro('done'), total);
    return () => window.clearTimeout(timer);
    // Re-running on a scope switch is harmless: the session flag is already set, so it only
    // confirms `done`.
  }, [decided, animating, shapes]);

  // ---- motes: faint teal dust behind the head, Canvas not DOM ----
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!animating) return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext?.('2d');
    if (canvas === null || context === null || context === undefined) return;
    const ratio = window.devicePixelRatio || 1;
    let width = 0;
    let height = 0;
    let points: { x: number; y: number; r: number; v: number; a: number }[] = [];
    const size = () => {
      const rect = canvas.getBoundingClientRect();
      width = canvas.width = Math.floor(rect.width * ratio);
      height = canvas.height = Math.floor(rect.height * ratio);
      points = Array.from({ length: MOTES.count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        r: (Math.random() * 1.2 + 0.4) * ratio,
        v: Math.random() * 0.12 + 0.03,
        a: Math.random() * Math.PI * 2,
      }));
    };
    size();
    window.addEventListener('resize', size);
    const accent = getComputedStyle(canvas).getPropertyValue('--color-accent').trim() || '#5fd3b9';
    let frame = 0;
    const tick = (time: number) => {
      context.clearRect(0, 0, width, height);
      for (const point of points) {
        point.y -= point.v * ratio;
        point.x += Math.sin(time * 0.0004 + point.a) * 0.15 * ratio;
        if (point.y < -4) {
          point.y = height + 4;
          point.x = Math.random() * width;
        }
        const twinkle = 0.5 + 0.5 * Math.sin(time * 0.0015 + point.a);
        context.globalAlpha = 0.05 + 0.18 * twinkle;
        context.fillStyle = accent;
        context.beginPath();
        context.arc(point.x, point.y, point.r, 0, Math.PI * 2);
        context.fill();
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', size);
    };
  }, [animating]);

  // ---- gaze: head and serpents lean a little toward the pointer ----
  const onMouseMove = (event: MouseEvent<HTMLElement>) => {
    if (!animating || railRef.current === null) return;
    const rect = railRef.current.getBoundingClientRect();
    const gx = (event.clientX - rect.left) / rect.width - 0.5;
    const gy = (event.clientY - rect.top) / rect.height - 0.5;
    gazeRef.current = gy;
    if (headRef.current !== null) {
      headRef.current.style.transform = `translate(${(gx * 4).toFixed(1)}px, ${(gy * 3).toFixed(1)}px)`;
    }
  };

  const restPose = (active: boolean): Pose => ({ ...REST_POSE, lift: active ? 1 : 0 });

  const headArtwork = (
    <g ref={headRef} className={styles.headGroup} aria-hidden="true" data-testid="medusa-head">
      <image
        href={HEAD_ASSET}
        x={HEAD_BOX.x}
        y={HEAD_BOX.y}
        width={HEAD_BOX.width}
        height={HEAD_BOX.height}
        mask="url(#medusa-feather)"
        preserveAspectRatio="xMidYMid slice"
      />
    </g>
  );

  const defs = (
    <defs>
      <linearGradient id="medusa-fade-x" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor="#fff" />
        <stop offset=".72" stopColor="#fff" />
        <stop offset="1" stopColor="#000" />
      </linearGradient>
      <linearGradient id="medusa-fade-y" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#000" />
        <stop offset=".06" stopColor="#fff" />
        <stop offset=".8" stopColor="#fff" />
        <stop offset="1" stopColor="#000" />
      </linearGradient>
      {/* A luminance mask: white keeps, black hides. These are mask values, not palette colours. */}
      <mask id="medusa-feather" maskContentUnits="userSpaceOnUse">
        <rect
          x={HEAD_BOX.x}
          y={HEAD_BOX.y}
          width={HEAD_BOX.width}
          height={HEAD_BOX.height}
          fill="url(#medusa-fade-x)"
        />
        <rect
          x={HEAD_BOX.x}
          y={HEAD_BOX.y}
          width={HEAD_BOX.width}
          height={HEAD_BOX.height}
          fill="url(#medusa-fade-y)"
          style={{ mixBlendMode: 'multiply' }}
        />
      </mask>
    </defs>
  );

  return (
    <aside
      ref={railRef}
      aria-label="Medusa navigation rail"
      className={cn(styles.rail, introducing && styles.intro, breathing && styles.breathing)}
      onMouseMove={onMouseMove}
      data-list-view={showList ? 'true' : 'false'}
      data-intro={intro}
    >
      <div className={styles.brand}>
        MEDUSA
        <small className={styles.brandSmall}>{scopes[scope].small}</small>
      </div>

      {available.length > 1 && (
        <div className={styles.scope} role="group" aria-label="Scope">
          {available.map((candidate) => (
            <button
              key={candidate}
              type="button"
              className={styles.scopeButton}
              aria-pressed={candidate === scope}
              onClick={() => setScope(candidate)}
            >
              {candidate === 'hq' ? 'HQ' : 'Store'}
            </button>
          ))}
        </div>
      )}

      {animating && <canvas ref={canvasRef} className={styles.motes} aria-hidden="true" />}

      {showList ? (
        <>
          <svg
            className={cn(styles.svg, styles.headOnly)}
            viewBox={`0 0 ${RAIL_VIEWBOX.width} ${RAIL_VIEWBOX.height}`}
            preserveAspectRatio="xMidYMin meet"
            aria-hidden="true"
          >
            {defs}
            {headArtwork}
          </svg>
          <RailList label={scopes[scope].label} items={items} />
        </>
      ) : (
        <nav aria-label={scopes[scope].label} className={styles.stage}>
          <svg
            className={styles.svg}
            viewBox={`0 0 ${RAIL_VIEWBOX.width} ${RAIL_VIEWBOX.height}`}
            preserveAspectRatio="xMidYMin meet"
            role="group"
            aria-label="Sections"
          >
            {defs}
            <g data-testid="medusa-serpents">
              {shapes.map((shape, index) => {
                const item = items[index];
                if (item === undefined) return null;
                const active = item.id === activeId;
                const a = poseAttributes(shape, restPose(active), item.label);
                return (
                  <g
                    key={item.id}
                    ref={(element) => {
                      groupRefs.current[index] = element;
                    }}
                    className={cn(
                      styles.snake,
                      active && styles.active,
                      introducing && styles.grow,
                    )}
                    role="button"
                    tabIndex={0}
                    aria-label={item.label}
                    aria-pressed={active}
                    data-section={item.id}
                    onClick={() => navigate(item.href)}
                    onKeyDown={onKeyDown(item.href)}
                    onMouseEnter={() => {
                      hoverRef.current = index;
                    }}
                    onMouseLeave={() => {
                      hoverRef.current = null;
                    }}
                  >
                    <path
                      data-part="outer"
                      className={styles.bodyOuter}
                      d={a.d}
                      strokeWidth={a.outerWidth}
                    />
                    <path
                      data-part="body"
                      className={styles.body}
                      d={a.d}
                      strokeWidth={a.bodyWidth}
                    />
                    <path
                      data-part="scales"
                      className={styles.scales}
                      d={a.d}
                      strokeWidth={STROKE.scales}
                    />
                    <ellipse
                      data-part="head"
                      className={styles.head}
                      cx={shape.tip.x}
                      cy={shape.tip.y}
                      rx="11"
                      ry="6.5"
                      transform={a.headTransform}
                    />
                    <circle
                      data-part="eye"
                      className={styles.eye}
                      cx={a.eye.x.toFixed(1)}
                      cy={a.eye.y.toFixed(1)}
                      r="1.8"
                    />
                    <path data-part="tongue" className={styles.tongue} d={a.tongue} />
                    <rect
                      data-part="ring"
                      className={styles.focusRing}
                      x={a.ring.x}
                      y={a.ring.y}
                      width={a.ring.width}
                      height={a.ring.height}
                      rx="6"
                    />
                    <text data-part="label" className={styles.label} x={a.text.x} y={a.text.y}>
                      {item.label}
                    </text>
                  </g>
                );
              })}
            </g>
            {headArtwork}
          </svg>
        </nav>
      )}

      <div className={styles.foot}>
        <div className={styles.who}>
          <span className={styles.dot} aria-hidden="true" />
          <span>
            Signed in as <b>{userName}</b>
          </span>
        </div>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={showList}
            disabled={reduced}
            onChange={(event) => toggleList(event.currentTarget.checked)}
          />
          List view
        </label>
      </div>
    </aside>
  );
}
