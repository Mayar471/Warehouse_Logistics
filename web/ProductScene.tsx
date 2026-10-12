import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Product } from '../shared/catalog.js';

// These intentionally schematic models illustrate the demo catalog, not real SKU geometry.
function makeProduct(kind: Product['icon'], color: string) {
  const group = new THREE.Group();
  const shell = new THREE.MeshPhysicalMaterial({
    color,
    roughness: 0.34,
    metalness: 0.18,
    clearcoat: 0.3,
  });
  const dark = new THREE.MeshStandardMaterial({ color: '#241d2c', roughness: 0.55 });
  const gold = new THREE.MeshStandardMaterial({
    color: '#cba777',
    metalness: 0.8,
    roughness: 0.27,
  });
  const light = new THREE.MeshStandardMaterial({ color: '#eee4d8', roughness: 0.4 });
  group.userData.materials = [shell, dark, gold, light];
  const mesh = (geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0) => {
    const part = new THREE.Mesh(geometry, material);
    part.position.set(x, y, z);
    group.add(part);
    return part;
  };
  const box = (
    w: number,
    h: number,
    d: number,
    m: THREE.Material,
    x = 0,
    y = 0,
    z = 0,
    radius = 0.1,
  ) => mesh(new RoundedBoxGeometry(w, h, d, 3, radius), m, x, y, z);
  const ring = (
    radius: number,
    tube: number,
    m: THREE.Material,
    x = 0,
    y = 0,
    z = 0,
    arc = Math.PI * 2,
  ) => mesh(new THREE.TorusGeometry(radius, tube, 12, 64, arc), m, x, y, z);
  if (kind === 'headphones') {
    ring(0.89, 0.11, shell, 0, 0.1, 0, Math.PI);
    ring(0.79, 0.06, dark, 0, 0.1, 0, Math.PI);
    for (const side of [-1, 1]) {
      box(0.12, 0.52, 0.13, gold, side * 0.86, -0.1);
      box(0.41, 0.74, 0.48, shell, side * 0.87, -0.5, 0, 0.18);
      box(0.15, 0.64, 0.43, dark, side * 0.64, -0.5, 0, 0.07);
      box(0.035, 0.23, 0.06, gold, side * 1.08, -0.5, 0.15, 0.015);
    }
  } else if (kind === 'bag') {
    box(1.65, 1.48, 0.66, shell, 0, -0.17, 0, 0.16);
    box(1.4, 0.09, 0.68, dark, 0, 0.54, 0, 0.03);
    for (const z of [-0.22, 0.22]) {
      const handle = ring(0.38, 0.06, shell, 0, 0.6, z, Math.PI);
      handle.scale.y = 1.4;
      for (const x of [-0.38, 0.38])
        box(0.12, 0.26, 0.05, shell, x, 0.45, z > 0 ? 0.36 : -0.36, 0.03);
    }
    box(0.27, 0.13, 0.025, gold, 0, 0.21, 0.343, 0.025);
    box(1.25, 0.018, 0.018, gold, 0, -0.64, 0.338, 0.006);
  } else if (kind === 'cup') {
    const points = [
      new THREE.Vector2(0, -0.75),
      new THREE.Vector2(0.51, -0.75),
      new THREE.Vector2(0.64, -0.6),
      new THREE.Vector2(0.69, 0.62),
      new THREE.Vector2(0.63, 0.67),
      new THREE.Vector2(0.58, -0.52),
      new THREE.Vector2(0, -0.57),
    ];
    mesh(new THREE.LatheGeometry(points, 64), shell);
    const handle = ring(0.4, 0.11, shell, 0.78, -0.02);
    handle.scale.x = 0.8;
    mesh(
      new THREE.CylinderGeometry(0.59, 0.59, 0.015, 48),
      new THREE.MeshStandardMaterial({ color: '#392316', roughness: 0.25 }),
      0,
      0.43,
    );
    mesh(new THREE.CylinderGeometry(0.92, 0.88, 0.07, 64), light, 0, -0.81);
  } else if (kind === 'lamp') {
    mesh(new THREE.CylinderGeometry(0.63, 0.7, 0.13, 48), shell, 0, -0.94);
    const arm = mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.42, 16), gold, 0.15, -0.18);
    arm.rotation.z = -0.25;
    mesh(new THREE.SphereGeometry(0.12, 20, 12), gold, 0.32, 0.53);
    const shade = mesh(new THREE.ConeGeometry(0.62, 0.62, 48, 1, true), shell, 0.06, 0.65);
    shade.material = new THREE.MeshPhysicalMaterial({
      color,
      roughness: 0.38,
      side: THREE.DoubleSide,
    });
    mesh(
      new THREE.CylinderGeometry(0.58, 0.58, 0.035, 48),
      new THREE.MeshStandardMaterial({
        color: '#fff3c9',
        emissive: '#ffd780',
        emissiveIntensity: 0.5,
      }),
      0.06,
      0.35,
    );
  } else if (kind === 'watch') {
    box(0.65, 2.5, 0.12, shell, 0, 0, -0.08, 0.13);
    box(1.03, 1.25, 0.3, gold, 0, 0, 0.06, 0.19);
    box(0.91, 1.13, 0.08, dark, 0, 0, 0.23, 0.18);
    const face = ring(
      0.28,
      0.027,
      new THREE.MeshStandardMaterial({
        color: '#cc78b3',
        emissive: '#862364',
        emissiveIntensity: 0.35,
      }),
      0,
      0,
      0.284,
    );
    face.scale.y = 1.03;
    box(0.035, 0.28, 0.02, light, 0, 0.08, 0.29, 0.01);
    const hand = box(0.2, 0.035, 0.02, light, 0.08, 0, 0.29, 0.01);
    hand.rotation.z = -0.4;
    mesh(new THREE.SphereGeometry(0.032, 12, 8), gold, 0, 0, 0.31);
    const crown = mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.1, 20), gold, 0.55, 0.14, 0.04);
    crown.rotation.z = Math.PI / 2;
    for (let y = 0.8; y < 1.2; y += 0.13) box(0.045, 0.055, 0.013, dark, 0, -y, -0.011, 0.01);
  } else {
    box(1.8, 1.17, 0.35, shell, 0, 0, 0, 0.12);
    box(1.66, 1.03, 0.018, gold, 0, 0, 0.18, 0.09);
    box(1.62, 0.99, 0.026, shell, 0, 0, 0.2, 0.08);
    box(0.45, 0.27, 0.08, shell, 0.64, 0, 0.22, 0.08);
    mesh(new THREE.SphereGeometry(0.055, 16, 12), gold, 0.63, 0, 0.27);
  }
  return group;
}

export default function ProductScene({
  product,
  interactive = false,
  decorative = false,
  color = '#946b91',
  zoom = 1,
}: {
  product: Product;
  interactive?: boolean;
  decorative?: boolean;
  color?: string;
  zoom?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const zoomRef = useRef(zoom);
  const redraw = useRef<(() => void) | null>(null);
  zoomRef.current = zoom;
  useEffect(() => {
    redraw.current?.();
  }, [zoom]);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        powerPreference: 'low-power',
      });
    } catch {
      setFailed(true);
      return;
    }
    setFailed(false);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    renderer.setClearColor(0, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.3;
    element.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 30);
    camera.position.set(0, 0.2, 5.9);
    const model = makeProduct(product.icon, color);
    model.rotation.set(0.08, -0.45, -0.1);
    scene.add(model, new THREE.HemisphereLight('#fff5ff', '#655775', 3));
    for (const [x, y, z, intensity] of [
      [-3, 4, 4, 6],
      [3, 1, -2, 5],
    ]) {
      const lamp = new THREE.DirectionalLight('#ffffff', intensity);
      lamp.position.set(x, y, z);
      scene.add(lamp);
    }
    let targetX = 0.08,
      targetY = -0.45,
      visible = false,
      frame = 0,
      dragging = false,
      hasDragged = false;
    let previousX = 0,
      previousY = 0;
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    const draw = () => {
      camera.position.z = 5.9 / zoomRef.current;
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
    };
    redraw.current = draw;
    const resize = new ResizeObserver(() => {
      const { width, height } = element.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      draw();
    });
    resize.observe(element);
    const tick = (time: number) => {
      if (!visible || document.hidden) {
        frame = 0;
        return;
      }
      model.rotation.x = THREE.MathUtils.lerp(model.rotation.x, targetX, 0.07);
      model.rotation.y = THREE.MathUtils.lerp(model.rotation.y, targetY, 0.07);
      model.position.y = reducedMotion.matches ? 0 : Math.sin(time * 0.00085) * 0.065;
      if (decorative && !reducedMotion.matches) {
        model.rotation.y = -0.45 + Math.sin(time * 0.0004) * 0.95;
        model.rotation.z = -0.1 + Math.sin(time * 0.00055) * 0.07;
      }
      draw();
      frame = reducedMotion.matches ? 0 : requestAnimationFrame(tick);
    };
    const updatePose = () => {
      if (!reducedMotion.matches) return;
      model.rotation.x = targetX;
      model.rotation.y = targetY;
      model.position.y = 0;
      draw();
    };
    const start = () => {
      if ((interactive || decorative) && visible && !document.hidden && !frame)
        frame = requestAnimationFrame(tick);
    };
    const motionChange = () => {
      updatePose();
      start();
    };
    reducedMotion.addEventListener('change', motionChange);
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        start();
      },
      { threshold: 0.05 },
    );
    observer.observe(element);
    document.addEventListener('visibilitychange', start);
    const move = (event: PointerEvent) => {
      if (!interactive) return;
      if (dragging) {
        targetY += (event.clientX - previousX) * 0.012;
        targetX = Math.max(-1, Math.min(1, targetX + (event.clientY - previousY) * 0.008));
      } else if (event.pointerType === 'mouse' && !reducedMotion.matches && !hasDragged) {
        const rect = element.getBoundingClientRect();
        targetY = -0.45 + ((event.clientX - rect.left) / rect.width - 0.5) * 0.7;
        targetX = ((event.clientY - rect.top) / rect.height - 0.5) * 0.35;
      }
      previousX = event.clientX;
      previousY = event.clientY;
      updatePose();
    };
    const down = (event: PointerEvent) => {
      dragging = true;
      hasDragged = true;
      previousX = event.clientX;
      previousY = event.clientY;
      element.setPointerCapture(event.pointerId);
    };
    const up = () => {
      dragging = false;
    };
    const key = (event: KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      hasDragged = true;
      targetY += event.key === 'ArrowLeft' ? -0.2 : event.key === 'ArrowRight' ? 0.2 : 0;
      targetX = Math.max(
        -1,
        Math.min(
          1,
          targetX + (event.key === 'ArrowUp' ? -0.15 : event.key === 'ArrowDown' ? 0.15 : 0),
        ),
      );
      updatePose();
    };
    if (interactive) {
      element.addEventListener('pointermove', move);
      element.addEventListener('pointerdown', down);
      element.addEventListener('pointerup', up);
      element.addEventListener('pointercancel', up);
      element.addEventListener('keydown', key);
    }
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      observer.disconnect();
      reducedMotion.removeEventListener('change', motionChange);
      redraw.current = null;
      document.removeEventListener('visibilitychange', start);
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', up);
      element.removeEventListener('keydown', key);
      const materials = new Set<THREE.Material>();
      for (const material of model.userData.materials as THREE.Material[]) materials.add(material);
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          for (const material of [object.material].flat()) materials.add(material);
        }
      });
      materials.forEach((material) => material.dispose());
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [product.icon, interactive, decorative, color]);
  return (
    <div
      ref={host}
      className={`product-scene ${failed ? 'scene-failed' : ''}`}
      tabIndex={interactive ? 0 : undefined}
      role={interactive ? 'img' : undefined}
      aria-label={
        interactive
          ? `مجسم توضيحي: ${product.name}. اسحب أو استخدم أسهم لوحة المفاتيح للتدوير.`
          : undefined
      }
      aria-hidden={interactive ? undefined : true}
    >
      {failed && interactive && (
        <span className="scene-fallback">المعاينة ثلاثية الأبعاد غير متاحة على هذا الجهاز.</span>
      )}
    </div>
  );
}
