import * as THREE from 'three';

/**
 * World-space pattern injection for lit standard materials.
 *
 * Arena surfaces need patterns that are anchored to the arena rather than to a
 * texture's UV repeat: mow bands that run the true length of the pitch, panel
 * seams spaced against the real wall, a team split that falls exactly on the
 * centre line. A repeating texture cannot express any of those without visible
 * tiling, and a `ShaderMaterial` could, but only by dropping the surface out of
 * the stadium lighting and leaving it reading as a flat sheet.
 *
 * Patching the standard shader keeps the lighting and replaces only the albedo.
 * Both the containment wall and the turf use this, which is why it lives here
 * instead of inside either of them.
 */

/** Emit a GLSL float literal, so a baked constant always parses as source. */
export function glslFloat(value: number): string {
  return (Number.isFinite(value) ? value : 0).toFixed(5);
}

/**
 * Emit a palette entry as a GLSL constructor.
 *
 * `THREE.Color` already converts a hex literal out of sRGB into the renderer's
 * working space, which is the same space `diffuseColor` is in, so these channels
 * can be written straight into the fragment without a second conversion.
 */
export function glslColor(hex: number): string {
  const color = new THREE.Color(hex);
  return `vec3(${glslFloat(color.r)}, ${glslFloat(color.g)}, ${glslFloat(color.b)})`;
}

/**
 * Inject a world-space pattern into a lit standard material.
 *
 * The pattern source runs after `color_fragment`, so it can read and modify
 * `diffuseColor`, which means a pattern can either replace the albedo outright or
 * tint whatever texture the material already carries. `vArenaWorld` holds the
 * fragment's world position.
 *
 * Arena dimensions are expected to be baked into the source as literals rather
 * than passed as uniforms: they are fixed for the life of the material, and a
 * literal cannot be left stale by a missed update.
 */
export function withWorldPattern<T extends THREE.MeshStandardMaterial>(
  material: T,
  patternSource: string,
): T {
  material.onBeforeCompile = (shader): void => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vArenaWorld;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vArenaWorld = (modelMatrix * vec4(position, 1.0)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vArenaWorld;')
      .replace('#include <color_fragment>', `#include <color_fragment>\n${patternSource}`);
  };
  // Two materials with identical source may still be patched differently, so the
  // key has to change with the source rather than with the material type.
  material.customProgramCacheKey = (): string => patternSource;
  return material;
}
