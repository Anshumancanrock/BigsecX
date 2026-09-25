/**
 * The landing page's phone in three.js. WebGL draws the device and the DOM
 * draws its screen: every frame computes the CSS transform that places the
 * screen element exactly over the glass. At rest that transform is a plain
 * translation, so the screen's text is rasterised at its displayed size.
 *
 * World units are the screen's design pixels (390 x 845). The phone settles
 * in on first view, leans slightly toward the pointer, and renders nothing
 * while off screen or at rest.
 */

import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  ExtrudeGeometry,
  Group,
  HemisphereLight,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  PMREMGenerator,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  Shape,
  ShapeGeometry,
  SRGBColorSpace,
  WebGLRenderer,
  type BufferGeometry,
  type Material,
} from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

/* ------------------------------------------------------------ dimensions */

export const SCREEN = { width: 390, height: 845 } as const;
const PHONE_W = SCREEN.width / 0.9174;
const RING = 0.008 * PHONE_W;
const BEZEL = 0.033841463414634148 * (PHONE_W - 2 * RING);
const PHONE_H = SCREEN.height + 2 * (RING + BEZEL);
const PHONE_R = 0.18 * PHONE_W;
const GLASS_R = PHONE_R - RING;
const DEPTH = 44;
/** The rounding of the frame's edges, seen only when the phone turns. */
const EDGE = 2;

/*
 * The front plane holds the ring, the glass and the screen, and the camera
 * maps one unit in it to one pixel, so edges stay on the pixel grid. It sits
 * a full unit clear of the frame's face and the button keys: with a 16-bit
 * depth buffer, a smaller gap shows through as speckles.
 */
const FRONT_Z = DEPTH / 2 + 1;

/** Left and right buttons: top and height as fractions of the phone. */
const BUTTONS = [
  { side: -1, top: 0.208, height: 0.052 },
  { side: -1, top: 0.29, height: 0.062 },
  { side: -1, top: 0.375, height: 0.062 },
  { side: 1, top: 0.315, height: 0.125 },
] as const;

/** On-screen width of the phone at full size. */
const PHONE_PX = 334;
/** Side buttons: 4px wide, standing 3px out from the ring, with 3px corners. */
const BUTTON_SPAN = 4 * (PHONE_W / PHONE_PX);
const BUTTON_OUT = 3 * (PHONE_W / PHONE_PX);
const BUTTON_CORNER = 3 * (PHONE_W / PHONE_PX);
/** Room around the phone so a lean never clips its edge. */
const SIDE_ROOM = 56;
/** Space above the phone's top edge, for the settle-in and the lean. */
const TOP_ROOM = 14;
/** How far the phone leans toward the pointer, in radians. */
const LEAN = { x: 0.08, y: 0.16 } as const;

/** A rectangle with circular corners, centred on the origin. */
function roundedRect(width: number, height: number, radius: number): Shape {
  const x = width / 2;
  const y = height / 2;
  const r = Math.min(radius, x, y);
  const shape = new Shape();
  shape.moveTo(-x + r, -y);
  shape.lineTo(x - r, -y);
  shape.absarc(x - r, -y + r, r, -Math.PI / 2, 0, false);
  shape.lineTo(x, y - r);
  shape.absarc(x - r, y - r, r, 0, Math.PI / 2, false);
  shape.lineTo(-x + r, y);
  shape.absarc(-x + r, y - r, r, Math.PI / 2, Math.PI, false);
  shape.lineTo(-x, -y + r);
  shape.absarc(-x + r, -y + r, r, Math.PI, 1.5 * Math.PI, false);
  return shape;
}

/* -------------------------------------------------------------- the shaders */

const FLAT_VERTEX = /* glsl */ `
  varying vec3 vLocal;
  varying vec3 vNormal;
  void main() {
    vLocal = position;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/*
 * The ring's shading: a 145-degree gradient (#dcdce2, #9d9da4, #4b4b51,
 * #83838a, #d2d2d8) across the phone with a darker outermost pixel, except
 * beside a button. Colours are mixed in sRGB like the browser does, so they
 * match CSS. `uShift` slides the gradient while the phone turns, like a
 * reflection.
 */
const RING_FRAGMENT = /* glsl */ `
  uniform vec2 uSize;
  uniform float uRadius;
  uniform float uHairline;
  uniform float uShift;
  uniform vec3 uButtons[4];
  uniform float uButtonOut;
  uniform float uButtonSpan;
  varying vec3 vLocal;

  vec3 key(float u);

  vec3 titanium(float t) {
    vec3 c0 = vec3(220.0, 220.0, 226.0) / 255.0;
    vec3 c1 = vec3(157.0, 157.0, 164.0) / 255.0;
    vec3 c2 = vec3(75.0, 75.0, 81.0) / 255.0;
    vec3 c3 = vec3(131.0, 131.0, 138.0) / 255.0;
    vec3 c4 = vec3(210.0, 210.0, 216.0) / 255.0;
    t = clamp(t, 0.0, 1.0);
    if (t < 0.20) return mix(c0, c1, t / 0.20);
    if (t < 0.48) return mix(c1, c2, (t - 0.20) / 0.28);
    if (t < 0.74) return mix(c2, c3, (t - 0.48) / 0.26);
    return mix(c3, c4, (t - 0.74) / 0.26);
  }

  float roundedBox(vec2 p, vec2 halfSize, float r) {
    vec2 q = abs(p) - halfSize + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  }

  void main() {
    // CSS measures the angle clockwise from "to top", with y pointing down,
    // and stretches the gradient to reach the box's far corners.
    float a = radians(145.0);
    vec2 dir = vec2(sin(a), -cos(a));
    float len = abs(uSize.x * sin(a)) + abs(uSize.y * cos(a));
    vec3 colour = titanium(0.5 + dot(vec2(vLocal.x, -vLocal.y), dir) / len + uShift);
    float inside = -roundedBox(vLocal.xy, uSize * 0.5, uRadius);
    float aa = fwidth(inside) * 0.5;
    colour *= 1.0 - 0.55 * (1.0 - smoothstep(uHairline - aa, uHairline + aa, inside));
    for (int i = 0; i < 4; i++) {
      vec3 b = uButtons[i];
      if (sign(vLocal.x) == b.x && vLocal.y >= b.y && vLocal.y <= b.z && inside < uButtonSpan - uButtonOut) {
        colour = key((uButtonOut + inside) / uButtonSpan);
      }
    }
    gl_FragColor = vec4(colour, 1.0);
  }
`;

/*
 * A side button's face: a gradient (#84848b, #4d4d53 at 55%, #2c2c31) running
 * inward from the outer edge. It darkens as it turns away from the camera.
 */
const BUTTON_FRAGMENT = /* glsl */ `
  uniform float uSide;
  uniform float uOuter;
  uniform float uSpan;
  varying vec3 vLocal;
  varying vec3 vNormal;

  vec3 key(float u);

  void main() {
    vec3 colour = key((uOuter - uSide * vLocal.x) / uSpan);
    colour *= mix(0.6, 1.0, clamp(vNormal.z, 0.0, 1.0));
    gl_FragColor = vec4(colour, 1.0);
  }
`;

/** The button gradient, shared by the button faces and the ring beside them. */
const KEY_GRADIENT = /* glsl */ `
  vec3 key(float u) {
    vec3 c0 = vec3(132.0, 132.0, 139.0) / 255.0;
    vec3 c1 = vec3(77.0, 77.0, 83.0) / 255.0;
    vec3 c2 = vec3(44.0, 44.0, 49.0) / 255.0;
    u = clamp(u, 0.0, 1.0);
    return u < 0.55 ? mix(c0, c1, u / 0.55) : mix(c1, c2, (u - 0.55) / 0.45);
  }
`;

/* ---------------------------------------------------------------- the scene */

export interface PhoneScene {
  dispose(): void;
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;

/**
 * Build the scene in `stage` around `screen`. Returns null when WebGL is not
 * available, so the caller can show the flat phone instead.
 */
export function mountPhoneScene(
  stage: HTMLElement,
  screen: HTMLElement,
  options: {
    /** Where the pointer's position steers the lean. */
    readonly tiltArea: HTMLElement;
    readonly onVisible: (visible: boolean) => void;
  },
): PhoneScene | null {
  // Request the context first: without WebGL, three.js logs an error before
  // throwing, and a missing WebGL only means the flat fallback. The renderer is
  // then handed the same context.
  const canvas = document.createElement("canvas");
  const attributes = { antialias: true, alpha: true, powerPreference: "low-power" } as const;
  if (!canvas.getContext("webgl2", attributes)) return null;
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, ...attributes });
  } catch {
    return null;
  }
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Only a mouse or pen can lean the phone; without one it needs no margin for
  // it and fills a narrow screen.
  const leans = !reduced && matchMedia("(hover: hover) and (pointer: fine)").matches;

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.domElement.className = "phone-gl";

  // The screen's layer: the anchor carries the projection, the screen inside
  // it the zoom that lays it out at its drawn size.
  const layer = document.createElement("div");
  layer.className = "phone-css";
  const anchor = document.createElement("div");
  anchor.className = "phone-screen";
  anchor.append(screen);
  layer.append(anchor);
  stage.append(renderer.domElement, layer);

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  // Reflections apply to the metal only; the glass and the ring are flat
  // colours and must not mirror the environment.
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const disposables: (BufferGeometry | Material)[] = [];
  const track = <T extends BufferGeometry | Material>(thing: T): T => {
    disposables.push(thing);
    return thing;
  };

  // A soft sky above and a key light from the upper left, where the ring is brightest.
  scene.add(new HemisphereLight(0xffffff, 0x8a8a92, 1.3));
  const key = new DirectionalLight(0xffffff, 1.1);
  key.position.set(-1, 1.6, 2.2);
  scene.add(key);

  // ---- the device ------------------------------------------------------
  const phone = new Group();
  scene.add(phone);

  // The frame: brushed titanium, seen at its sides and edges when it turns.
  const titanium = track(
    new MeshPhysicalMaterial({
      color: new Color("#b9b9bf"),
      metalness: 0.85,
      roughness: 0.34,
      clearcoat: 0.3,
      clearcoatRoughness: 0.2,
      envMap: environment,
      envMapIntensity: 1.1,
    }),
  );
  const body = new Mesh(
    track(
      new ExtrudeGeometry(roundedRect(PHONE_W - 2 * EDGE, PHONE_H - 2 * EDGE, PHONE_R - EDGE), {
        depth: DEPTH - 2 * EDGE,
        bevelEnabled: true,
        bevelThickness: EDGE,
        bevelSize: EDGE,
        bevelSegments: 4,
        curveSegments: 48,
      }),
    ),
    titanium,
  );
  body.geometry.center();
  phone.add(body);

  // The ring: the frame's front face, from its outer edge to the glass.
  const ringShape = roundedRect(PHONE_W, PHONE_H, PHONE_R);
  ringShape.holes.push(roundedRect(PHONE_W - 2 * RING, PHONE_H - 2 * RING, GLASS_R));
  const ringMaterial = track(
    new ShaderMaterial({
      vertexShader: FLAT_VERTEX,
      fragmentShader: RING_FRAGMENT + KEY_GRADIENT,
      uniforms: {
        uSize: { value: [PHONE_W, PHONE_H] },
        uRadius: { value: PHONE_R },
        uHairline: { value: PHONE_W / PHONE_PX },
        uShift: { value: 0 },
        // Each button's side and the bottom and top of its span, in the
        // ring's own coordinates.
        uButtons: {
          value: BUTTONS.flatMap((b) => [
            b.side,
            PHONE_H / 2 - (b.top + b.height) * PHONE_H,
            PHONE_H / 2 - b.top * PHONE_H,
          ]),
        },
        uButtonOut: { value: BUTTON_OUT },
        uButtonSpan: { value: BUTTON_SPAN },
      },
    }),
  );
  const ring = new Mesh(track(new ShapeGeometry(ringShape, 48)), ringMaterial);
  ring.position.z = FRONT_Z;
  phone.add(ring);

  // The glass: flat black. The screen covers all of it except the bezel.
  const glass = new Mesh(
    track(new ShapeGeometry(roundedRect(PHONE_W - 2 * RING, PHONE_H - 2 * RING, GLASS_R), 48)),
    track(new MeshBasicMaterial({ color: new Color("#0b0b0b"), toneMapped: false })),
  );
  glass.position.z = FRONT_Z;
  phone.add(glass);

  // Side buttons: a metal key standing out of the frame. The face sits just
  // behind the front plane, so perspective does not pull it inward, and ends
  // under the ring, which draws the same gradient there, so either depth-test
  // winner gives the same pixel.
  const keyMaterial = track(
    new MeshPhysicalMaterial({
      color: new Color("#8e8e95"),
      metalness: 0.9,
      roughness: 0.32,
      envMap: environment,
      envMapIntensity: 1.1,
    }),
  );
  const keyWidth = BUTTON_OUT + 6;
  const keyDepth = 18;
  const faceWidth = BUTTON_OUT + 0.6;
  for (const b of BUTTONS) {
    const height = b.height * PHONE_H;
    const y = PHONE_H / 2 - (b.top * PHONE_H + height / 2);

    const box = new Mesh(track(new RoundedBoxGeometry(keyWidth, height, keyDepth, 2, 1.2)), keyMaterial);
    box.position.set(b.side * (PHONE_W / 2 + BUTTON_OUT - keyWidth / 2), y, FRONT_Z - 1 - keyDepth / 2);
    phone.add(box);

    const face = new Mesh(
      track(new ShapeGeometry(roundedRect(faceWidth, height, BUTTON_CORNER), 12)),
      track(
        new ShaderMaterial({
          vertexShader: FLAT_VERTEX,
          fragmentShader: BUTTON_FRAGMENT + KEY_GRADIENT,
          uniforms: {
            uSide: { value: b.side },
            uOuter: { value: faceWidth / 2 },
            uSpan: { value: BUTTON_SPAN },
          },
        }),
      ),
    );
    face.position.set(b.side * (PHONE_W / 2 + BUTTON_OUT - faceWidth / 2), y, FRONT_Z - 0.08);
    phone.add(face);
  }

  // ---- the camera ------------------------------------------------------
  const camera = new PerspectiveCamera(22, 1, 100, 10_000);
  const view = { width: 0, height: 0, pxPerUnit: PHONE_PX / PHONE_W };

  const layout = () => {
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    if (width === 0 || height === 0) return;
    view.width = width;
    view.height = height;
    renderer.setSize(width, height, false);
    renderer.domElement.style.width = `${width}px`;
    renderer.domElement.style.height = `${height}px`;

    // As wide as the design phone, or as wide as the stage allows.
    const phonePx = Math.min(PHONE_PX, width - (leans ? SIDE_ROOM : 8));
    view.pxPerUnit = phonePx / PHONE_W;
    camera.aspect = width / height;
    // Distance at which one unit on the glass is `pxPerUnit` pixels tall.
    const distance = height / (2 * view.pxPerUnit * Math.tan((camera.fov * Math.PI) / 360));
    // Aim so the phone's top edge sits TOP_ROOM pixels below the stage's.
    const centerY = PHONE_H / 2 - (height / 2 - TOP_ROOM) / view.pxPerUnit;
    camera.position.set(0, centerY, FRONT_Z + distance);
    camera.lookAt(0, centerY, FRONT_Z);
    // Near and far close around the phone, so the depth buffer's precision
    // is spent where the phone is.
    camera.near = distance / 2;
    camera.far = distance * 2;
    camera.updateProjectionMatrix();

    ringMaterial.uniforms.uHairline!.value = 1 / view.pxPerUnit;
    screen.style.zoom = String(view.pxPerUnit);
  };

  // ---- the screen's transform -------------------------------------------
  const toPhone = new Matrix4();
  const toStage = new Matrix4();
  const full = new Matrix4();

  /**
   * Put the screen where the camera sees the glass: the matrix from the
   * zoomed element's pixels to the stage's, through the phone and camera.
   */
  const placeScreen = () => {
    const k = 1 / view.pxPerUnit;
    // Element pixels, origin top-left and y down, to the phone's units.
    toPhone.set(k, 0, 0, -SCREEN.width / 2, 0, -k, 0, SCREEN.height / 2, 0, 0, 1, FRONT_Z, 0, 0, 0, 1);
    // Clip space to the stage's pixels, flattened onto the page.
    toStage.set(view.width / 2, 0, 0, view.width / 2, 0, -view.height / 2, 0, view.height / 2, 0, 0, 0, 0, 0, 0, 0, 1);
    full
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      .multiply(phone.matrixWorld)
      .multiply(toPhone)
      .premultiply(toStage);
    const e = full.elements;
    // Keep the element a plane, with no depth in or out, which also keeps
    // the matrix invertible; then scale it so w is 1 at the origin.
    e[2] = e[6] = e[8] = e[9] = e[11] = e[14] = 0;
    const w = e[15]!;
    for (let i = 0; i < 16; i++) e[i] = e[i]! / w;
    e[10] = 1;
    const flat = Math.abs(e[3]!) < 1e-9 && Math.abs(e[7]!) < 1e-9;
    anchor.style.transform = flat
      ? `matrix(${e[0]},${e[1]},${e[4]},${e[5]},${e[12]},${e[13]})`
      : `matrix3d(${e.join(",")})`;
  };

  // ---- motion ----------------------------------------------------------
  const target = { x: 0, y: 0 };
  const current = { x: reduced ? 0 : 0.32, y: 0 };
  let rise = reduced ? 0 : 1;
  // The entry is timed from the end of the first frame, which compiles the
  // shaders: on a slow device that alone can outlast the entry.
  let start = 0;
  let visible = true;
  let frame = 0;

  const onPointer = (event: PointerEvent) => {
    if (!leans || event.pointerType === "touch") return;
    const rect = options.tiltArea.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width - 0.5;
    const py = (event.clientY - rect.top) / rect.height - 0.5;
    target.y = Math.max(-1, Math.min(1, px * 2)) * LEAN.y;
    target.x = Math.max(-1, Math.min(1, py * 2)) * LEAN.x;
    wake();
  };
  const onLeave = () => {
    target.x = 0;
    target.y = 0;
    wake();
  };

  const render = () => {
    frame = 0;
    if (!visible) return;
    const t = start ? Math.min(1, (performance.now() - start) / 1400) : 0;
    const settling = t < 1 && !reduced;
    if (settling) {
      const k = easeOut(t);
      rise = 1 - k;
      current.x = 0.32 * (1 - k) + target.x * k;
    } else {
      rise = 0;
      current.x += (target.x - current.x) * 0.08;
    }
    current.y += (target.y - current.y) * 0.08;
    // Close enough is exactly there, so a phone at rest is exactly square
    // to the camera and its screen gets the plain, sharp transform.
    const moving = settling || Math.abs(target.x - current.x) > 1e-4 || Math.abs(target.y - current.y) > 1e-4;
    if (!moving) {
      current.x = target.x;
      current.y = target.y;
    }

    phone.rotation.x = current.x;
    phone.rotation.y = current.y;
    phone.position.y = -rise * 90;
    ringMaterial.uniforms.uShift!.value = current.y * 0.6 - current.x * 0.4;
    const opacity = reduced ? 1 : Math.min(1, t * 1.6);
    renderer.domElement.style.opacity = String(opacity);
    layer.style.opacity = String(opacity);

    renderer.render(scene, camera);
    placeScreen();
    if (!start) start = performance.now();

    if (moving) frame = requestAnimationFrame(render);
  };

  function wake() {
    if (!frame && visible) frame = requestAnimationFrame(render);
  }

  const resize = new ResizeObserver(() => {
    layout();
    wake();
  });
  resize.observe(stage);

  // Off screen, nothing is drawn and the screen stops ticking.
  const seen = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
    options.onVisible(visible);
    // Wake even when nothing changed: an entry cut short off screen
    // finishes when the phone comes back.
    if (visible) wake();
  });
  seen.observe(stage);

  options.tiltArea.addEventListener("pointermove", onPointer);
  options.tiltArea.addEventListener("pointerleave", onLeave);

  layout();
  wake();

  return {
    dispose() {
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect();
      seen.disconnect();
      options.tiltArea.removeEventListener("pointermove", onPointer);
      options.tiltArea.removeEventListener("pointerleave", onLeave);
      screen.style.zoom = "";
      screen.remove();
      for (const thing of disposables) thing.dispose();
      environment.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      layer.remove();
    },
  };
}
