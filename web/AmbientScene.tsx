import { useEffect, useRef } from 'react';
import * as THREE from 'three';

export default function AmbientScene() {
  const host = useRef<HTMLDivElement>(null);
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
      return;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.6;
    element.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 20);
    camera.position.z = 5;
    const geometry = new THREE.TorusKnotGeometry(0.67, 0.2, 100, 12, 2, 3);
    const material = new THREE.MeshStandardMaterial({
      color: '#dbea9a',
      metalness: 0.6,
      roughness: 0.26,
    });
    const jewel = new THREE.Mesh(geometry, material);
    jewel.rotation.set(0.5, 0.5, 0.2);
    scene.add(jewel, new THREE.HemisphereLight('#fffce4', '#6c225c', 3));
    const key = new THREE.DirectionalLight('#fff6cc', 5);
    key.position.set(-2, 3, 4);
    scene.add(key);
    let frame = 0,
      visible = false;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const draw = () => renderer.render(scene, camera);
    const tick = (time: number) => {
      frame = 0;
      if (!visible || document.hidden || motion.matches) return;
      jewel.rotation.y = 0.5 + Math.sin(time * 0.00025) * 0.4;
      jewel.rotation.z = 0.2 + Math.sin(time * 0.00035) * 0.1;
      draw();
      frame = requestAnimationFrame(tick);
    };
    const start = () => {
      if (visible && !frame && !document.hidden && !motion.matches)
        frame = requestAnimationFrame(tick);
    };
    const size = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      renderer.setSize(rect.width, rect.height);
      camera.aspect = rect.width / rect.height;
      camera.updateProjectionMatrix();
      draw();
    });
    size.observe(element);
    const visibility = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      start();
    });
    visibility.observe(element);
    document.addEventListener('visibilitychange', start);
    motion.addEventListener('change', start);
    return () => {
      cancelAnimationFrame(frame);
      size.disconnect();
      visibility.disconnect();
      document.removeEventListener('visibilitychange', start);
      motion.removeEventListener('change', start);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, []);
  return <div className="ambient-scene" ref={host} />;
}
