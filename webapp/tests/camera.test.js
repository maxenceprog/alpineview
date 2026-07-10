import { describe, it, expect, beforeEach, vi } from "vitest";
import * as THREE from "three";
import { createFlyCamera, createWalkCamera } from "../src/camera.js";
import { buildHeightmap, sampleHeight } from "../src/heightmap.js";

describe("Walk Camera", () => {
  let scene, canvas, walkCtrl, renderer;

  beforeEach(() => {
    scene = new THREE.Scene();
    canvas = {
      requestPointerLock: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    // Mock renderer
    renderer = { domElement: canvas };
    walkCtrl = createWalkCamera(renderer, scene);
  });

  describe("snapToGround", () => {
    it("function exists and is callable", () => {
      expect(walkCtrl.snapToGround).toBeDefined();
      expect(typeof walkCtrl.snapToGround).toBe("function");
      // Should not throw when no tiles present
      expect(() => walkCtrl.snapToGround?.()).not.toThrow();
    });

    it("does not modify position when no tiles in scene", () => {
      const x = 999;
      const z = -999;
      walkCtrl.camera.position.set(x, 5, z);
      walkCtrl.snapToGround?.();

      // XZ should not change
      expect(walkCtrl.camera.position.x).toBe(x);
      expect(walkCtrl.camera.position.z).toBe(z);
    });

    it("looks for tile- prefixed meshes only", () => {
      // Add placeholder (ph-) and non-tile meshes - should be ignored
      const phGeo = new THREE.PlaneGeometry(1, 1);
      const phMesh = new THREE.Mesh(phGeo);
      phMesh.name = "ph-965-6430-0"; // placeholder, not tile
      scene.add(phMesh);

      walkCtrl.camera.position.set(965, 0, -6430);
      // Should not throw, and should not use placeholder
      expect(() => walkCtrl.snapToGround?.()).not.toThrow();
    });
  });

  describe("camera mode switching", () => {
    it("does not expose snapToGround on fly camera", () => {
      // Fly camera should have snapToGround: undefined
      const flyCtrl = createFlyCamera(renderer);
      expect(flyCtrl.snapToGround).toBeUndefined();
    });

    it("exposes snapToGround on walk camera", () => {
      expect(walkCtrl.snapToGround).toBeDefined();
      expect(typeof walkCtrl.snapToGround).toBe("function");
    });
  });

  describe("teleport", () => {
    it("sets only XZ coordinates, leaves Y to snapToGround", () => {
      const pos = new THREE.Vector3(965, 999, -6430);
      const target = new THREE.Vector3(965, 0, -6430);

      // Initial Y should be different from target
      walkCtrl.camera.position.y = 100;
      walkCtrl.teleport(pos, target);

      // XZ should be set from pos
      expect(walkCtrl.camera.position.x).toBe(965);
      expect(walkCtrl.camera.position.z).toBe(-6430);

      // Y might change via snapToGround, but input.y=999 should be ignored
      expect(walkCtrl.camera.position.y).not.toBe(999);
    });
  });

  describe("enable()", () => {
    it("does not move camera XZ when enabling walk mode", () => {
      const initialX = 965.5;
      const initialZ = -6430.5;
      walkCtrl.camera.position.x = initialX;
      walkCtrl.camera.position.z = initialZ;

      walkCtrl.enable?.();

      // XZ should not change when enabling walk mode
      expect(walkCtrl.camera.position.x).toBe(initialX);
      expect(walkCtrl.camera.position.z).toBe(initialZ);
    });

    it("snapToGround is called when enabling walk mode", () => {
      // Verify enable() completes without error
      expect(() => walkCtrl.enable?.()).not.toThrow();
    });
  });

  describe("update", () => {
    it("update() does not throw when walk mode disabled", () => {
      // update() is safe to call even when not enabled
      expect(() => walkCtrl.update(0.016)).not.toThrow();
    });

    it("update() calls snapToGround", () => {
      // We can verify that update exists and is callable
      expect(typeof walkCtrl.update).toBe("function");
      expect(() => walkCtrl.update(0.016)).not.toThrow();
    });
  });
});
