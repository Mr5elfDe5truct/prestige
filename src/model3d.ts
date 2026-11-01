// The 3D viewer for Picture to 3D: a textured .glb (Pixal3D's output) in the Canvas panel, drawn with three.js bundled
// into Prestige (so it works offline). The file loads through the asset protocol like a render; drag to turn it, scroll
// to zoom, right-drag to move. It turns slowly until it's touched. Loaded on demand, so three.js isn't in the main bundle.
// Idol's Gaussian splats (.ply) are drawn by Spark (World Labs, MIT) in the same scene and controls.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

export interface ModelStats {
  triangles: number;
  textures: number;
  gaussians?: number; // a splat's, instead of triangles
  size: [number, number, number]; // the bounding box, in the model's units
}

/** Shows the model in `el` (`splat`: a Gaussian splat .ply); resolves with its stats and a function that stops and
 *  frees the viewer. */
export async function mountViewer(
  el: HTMLElement,
  url: string,
  splat = false,
): Promise<{ stats: ModelStats; dispose: () => void; snapshot: (size?: number) => string | null }> {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  el.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d0909);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 1.2;
  controls.addEventListener("start", () => (controls.autoRotate = false));

  let model: THREE.Object3D;
  let box: THREE.Box3;
  let gaussians: number | undefined;
  let freeSplat = () => {};
  if (splat) {
    const { SparkRenderer, SplatMesh } = await import("@sparkjsdev/spark");
    const spark = new SparkRenderer({ renderer });
    scene.add(spark);
    const mesh = new SplatMesh({ url });
    // 3D Gaussian splat files are y-down; turned over so the object stands upright.
    mesh.quaternion.set(1, 0, 0, 0);
    try {
      await untilLoaded(mesh.initialized);
    } catch (e) {
      mesh.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      throw e;
    }
    scene.add(mesh);
    model = mesh;
    mesh.updateMatrixWorld(true);
    box = mesh.getBoundingBox(true).applyMatrix4(mesh.matrixWorld);
    gaussians = (mesh as any).packedSplats?.numSplats;
    freeSplat = () => mesh.dispose();
  } else {
    const gltf = await new GLTFLoader().loadAsync(url);
    model = gltf.scene;
    scene.add(model);
    box = new THREE.Box3().setFromObject(model);
  }
  // Fit: centre the model and back the camera off until it fills about two thirds of the view.
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  model.position.sub(centre);
  const radius = size.length() / 2 || 1;
  // The narrower of the two angles of view decides (the Canvas panel is usually taller than wide).
  const aspect = (el.clientWidth || 1) / (el.clientHeight || 1);
  const vHalf = THREE.MathUtils.degToRad(camera.fov / 2);
  const half = Math.min(vHalf, Math.atan(Math.tan(vHalf) * aspect));
  const dist = (radius / Math.sin(half)) * 1.05;
  const dir = new THREE.Vector3(0.6, 0.35, 0.75).normalize();
  camera.position.copy(dir.multiplyScalar(dist));
  camera.near = radius / 100;
  camera.far = radius * 100;
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  // A key light on top of the room's soft light, so the texture's relief reads.
  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set(dist, dist * 1.5, dist);
  scene.add(key);

  let triangles = 0;
  const textures = new Set<THREE.Texture>();
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry;
    triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
    for (const mat of ([] as THREE.Material[]).concat(m.material)) {
      for (const v of Object.values(mat)) if (v instanceof THREE.Texture) textures.add(v);
    }
  });

  const fit = () => {
    const w = el.clientWidth || 1;
    const h = el.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(fit);
  ro.observe(el);
  fit();
  let raf = 0;
  const loop = () => {
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  };
  loop();

  return {
    /** A JPEG data URL of the model as it is now, `size` pixels square (for its gallery tile); null while nothing shows. */
    snapshot: (size = 360) => {
      const w = el.clientWidth || size;
      const h = el.clientHeight || size;
      renderer.render(scene, camera); // the drawing buffer is only readable in the same task as a render
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const s = Math.min(w, h) * (renderer.domElement.width / w);
      const sx = (renderer.domElement.width - s) / 2;
      const sy = (renderer.domElement.height - s) / 2;
      const g = c.getContext("2d", { willReadFrequently: true })!;
      g.drawImage(renderer.domElement, sx, sy, s, s, 0, 0, size, size);
      // Nothing drawn yet (a splat appears once it has been sorted for the view): null, so the caller tries again.
      const px = g.getImageData(0, 0, size, size).data;
      let drawn = 0;
      for (let i = 0; i < px.length; i += 4 * 7) if (Math.abs(px[i] - 13) + Math.abs(px[i + 1] - 9) + Math.abs(px[i + 2] - 9) > 24) drawn++;
      return drawn > 20 ? c.toDataURL("image/jpeg", 0.86) : null;
    },
    stats: { triangles: Math.round(triangles), textures: textures.size, gaussians, size: [size.x, size.y, size.z] },
    dispose: () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      model.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.geometry.dispose();
        for (const mat of ([] as THREE.Material[]).concat(m.material)) mat.dispose();
      });
      textures.forEach((t) => t.dispose());
      freeSplat();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

/** Spark decodes the splat in a Web Worker with WebAssembly. If either is refused (the page's Content Security Policy) or
 *  the worker dies, `initialized` never settles; this turns that into an error instead of "Loading…" forever. */
function untilLoaded<T>(p: Promise<T>, ms = 180_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const blocked = (e: SecurityPolicyViolationEvent) => {
      if (/worker|script/.test(e.effectiveDirective)) finish(() => reject(new Error(`the splat decoder was blocked (${e.effectiveDirective})`)));
    };
    const failed = (e: ErrorEvent) => {
      if (/WebAssembly|Worker/i.test(e.message)) finish(() => reject(new Error(e.message)));
    };
    const timer = setTimeout(() => finish(() => reject(new Error("the splat took too long to load"))), ms);
    const finish = (f: () => void) => {
      clearTimeout(timer);
      document.removeEventListener("securitypolicyviolation", blocked);
      window.removeEventListener("error", failed);
      f();
    };
    document.addEventListener("securitypolicyviolation", blocked);
    window.addEventListener("error", failed);
    p.then((v) => finish(() => resolve(v)), (e) => finish(() => reject(e)));
  });
}
